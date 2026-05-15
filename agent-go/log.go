package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Logging structuré, JSON Lines vers fichier + pretty stdout en --debug.
// Le service tourne en SYSTEM ; on ne peut pas compter sur stdout pour la
// persistance. Une rotation simple par taille évite que le fichier grossisse
// indéfiniment.

const maxLogSize = 5 * 1024 * 1024 // 5 MiB

var (
	logMu       sync.Mutex
	logFile     *os.File
	prettyMode  bool // true en --debug pour formater pour humains au lieu de JSON
)

func logPath() string { return filepath.Join(dataDir(), "agent.log") }

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
}

// LogFields — type alias court pour les paires clé/valeur des logs structurés.
type LogFields map[string]any

// logEvent écrit une ligne structurée. event = identifiant kebab-case
// (ex. "checkin-ok"), message = texte humain optionnel.
func logEvent(level, event, message string, fields LogFields) {
	logMu.Lock()
	defer logMu.Unlock()

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

	if logFile != nil {
		_, _ = logFile.Write(raw)
		_, _ = logFile.WriteString("\n")
	}

	if prettyMode {
		fmt.Println(prettyFormat(entry))
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
func logInfo(event, msg string, fields LogFields)  { logEvent("info", event, msg, fields) }
func logWarn(event, msg string, fields LogFields)  { logEvent("warn", event, msg, fields) }
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

func closeLog() {
	logMu.Lock()
	defer logMu.Unlock()
	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}
}
