package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Logging structuré, JSON Lines vers fichier + pretty stdout en --debug.
// Le service tourne en SYSTEM ; on ne peut pas compter sur stdout pour la
// persistance.
//
// L'écriture fichier est DÉPORTÉE sur une goroutine dédiée derrière un
// canal bufferisé. Les call sites n'attendent jamais l'I/O disque : si le
// buffer est plein (disque lent/bloqué), le message est droppé plutôt que
// de figer l'appelant. C'est délibéré — l'incident 07/2026 a montré qu'un
// mutex de log tenu pendant une écriture bloquée figeait TOUTES les
// goroutines (checkin ET WebSocket). Un log ne doit jamais pouvoir wedger
// le reste de l'agent.

const maxLogSize = 5 * 1024 * 1024 // 5 MiB

// logJob — une entrée à écrire. pretty est non vide uniquement en --debug.
type logJob struct {
	line   []byte
	pretty string
}

var (
	logCh      chan logJob
	logStop    chan struct{}
	logDone    chan struct{}
	logFile    *os.File
	prettyMode bool // true en --debug pour formater pour humains au lieu de JSON
)

func logPath() string { return filepath.Join(dataDir(), "agent.log") }

// openLog ouvre le fichier de log et démarre la goroutine d'écriture.
// Appelé une seule fois au démarrage (cf. main).
func openLog() {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		log.Printf("mkdir dataDir : %v", err)
		return
	}
	if st, err := os.Stat(logPath()); err == nil && st.Size() > maxLogSize {
		_ = os.Rename(logPath(), logPath()+".old")
	}
	f, err := os.OpenFile(logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("open log : %v", err)
		return
	}
	logFile = f
	logCh = make(chan logJob, 1024)
	logStop = make(chan struct{})
	logDone = make(chan struct{})
	go logWriter()
}

// logWriter — unique consommateur du canal. Possède le cycle de vie de
// logFile (ouverture/rotation/fermeture) : aucun autre goroutine n'y touche.
func logWriter() {
	defer close(logDone)
	var written int64
	if logFile != nil {
		if st, err := logFile.Stat(); err == nil {
			written = st.Size()
		}
	}
	write := func(job logJob) {
		if job.pretty != "" {
			fmt.Println(job.pretty)
		}
		if logFile == nil {
			return
		}
		n, _ := logFile.Write(job.line)
		m, _ := logFile.WriteString("\n")
		written += int64(n + m)
		if written > maxLogSize {
			_ = logFile.Close()
			_ = os.Rename(logPath(), logPath()+".old")
			f, err := os.OpenFile(logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
			if err != nil {
				logFile = nil
				return
			}
			logFile = f
			written = 0
		}
	}
	for {
		select {
		case job := <-logCh:
			write(job)
		case <-logStop:
			// Drain best-effort puis fermeture.
			for {
				select {
				case job := <-logCh:
					write(job)
				default:
					if logFile != nil {
						_ = logFile.Close()
						logFile = nil
					}
					return
				}
			}
		}
	}
}

// LogFields — type alias court pour les paires clé/valeur des logs structurés.
type LogFields map[string]any

// logEvent écrit une ligne structurée. event = identifiant kebab-case
// (ex. "checkin-ok"), message = texte humain optionnel. Ne bloque JAMAIS.
func logEvent(level, event, message string, fields LogFields) {
	// Construction de l'entrée. Les champs réservés (ts/level/event) ne
	// peuvent pas être écrasés par fields ; les autres sont mergés en racine.
	entry := make(map[string]any, 4+len(fields))
	entry["ts"] = time.Now().Format(time.RFC3339)
	entry["level"] = level
	entry["event"] = event
	entry["agent_version"] = AgentVersion
	if message != "" {
		entry["msg"] = message
	}
	for k, v := range fields {
		switch k {
		case "ts", "level", "event", "agent_version":
			continue // protégés
		}
		entry[k] = v
	}

	raw, err := json.Marshal(entry)
	if err != nil {
		// Très improbable (json sur map[string]any) — fallback texte.
		raw = []byte(fmt.Sprintf(`{"ts":%q,"level":"error","event":"log-marshal-fail","msg":%q}`,
			entry["ts"], err.Error()))
	}

	job := logJob{line: raw}
	if prettyMode {
		job.pretty = prettyFormat(entry)
	}

	if logCh == nil {
		// openLog() pas encore appelé (très tôt dans le démarrage) : en
		// interactif on peut au moins imprimer, sinon on droppe.
		if prettyMode {
			fmt.Println(job.pretty)
		}
		return
	}

	// Envoi non bloquant : si le buffer est plein, on droppe. On ne ferme
	// jamais logCh (un envoi sur canal fermé paniquerait si un goroutine
	// logge pendant l'arrêt) — logStop signale la fin au writer.
	select {
	case logCh <- job:
	default:
		// buffer plein → drop silencieux
	}
}

// prettyFormat : "[ts] level event msg k1=v1 k2=v2"
func prettyFormat(entry map[string]any) string {
	ts, _ := entry["ts"].(string)
	level, _ := entry["level"].(string)
	event, _ := entry["event"].(string)
	msg, _ := entry["msg"].(string)
	out := fmt.Sprintf("[%s] %-5s %-20s %s", ts, level, event, msg)

	keys := make([]string, 0, len(entry))
	for k := range entry {
		switch k {
		case "ts", "level", "event", "msg", "agent_version":
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out += fmt.Sprintf(" %s=%v", k, entry[k])
	}
	return out
}

// Helpers — préférer ceux-ci pour les nouveaux call sites :
func logInfo(event, msg string, fields LogFields) { logEvent("info", event, msg, fields) }
func logWarn(event, msg string, fields LogFields) { logEvent("warn", event, msg, fields) }
func logError(event string, err error, fields LogFields) {
	if fields == nil {
		fields = LogFields{}
	}
	if err != nil {
		fields["error"] = err.Error()
	}
	logEvent("error", event, "", fields)
}

// logf — compat avec les call sites existants. La message formatée
// devient le champ "msg" d'un événement "log".
func logf(format string, args ...any) {
	logEvent("info", "log", fmt.Sprintf(format, args...), nil)
}

// closeLog signale l'arrêt au writer et attend le drain. Ne ferme pas
// logCh (voir logEvent) : sûr même si d'autres goroutines loggent encore.
func closeLog() {
	if logStop == nil {
		return
	}
	select {
	case <-logStop:
		// déjà fermé
	default:
		close(logStop)
	}
	if logDone != nil {
		<-logDone
	}
}
