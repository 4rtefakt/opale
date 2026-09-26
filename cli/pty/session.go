package pty

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"golang.org/x/term"
)

type wsMsg struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Connect ouvre une session terminal WebSocket (commandes console et ssh).
// serverURL est l'URL HTTP(S) de base du serveur Opale, wsPath le chemin et
// sa query string (ex. /api/console/:id?nonce=...).
// Envoi : { type:"input", data:"<b64>" } / { type:"resize", data:{cols,rows} }
// (identique pour SSH et console). Réception : cf. handleFrame, la forme de
// `data` dépend du transport.
func Connect(serverURL, wsPath string) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("stdin n'est pas un terminal interactif")
	}

	wsURL := toWS(serverURL) + wsPath
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("connexion WebSocket : %w", err)
	}
	defer conn.Close()

	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return fmt.Errorf("raw terminal : %w", err)
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)

	w := &wsWriter{conn: conn}

	// Initial size
	sendResize(w)

	// Resize notifications (SIGWINCH on Unix; no-op on Windows — see session_*.go)
	resizeCh := newResizeChan()
	defer stopResizeChan(resizeCh)

	done := make(chan error, 1)

	// server → stdout
	go func() {
		done <- readLoop(conn, os.Stdout, os.Stderr)
	}()

	// stdin → server
	go func() {
		pumpInput(os.Stdin, w)
		done <- nil
	}()

	// resize
	go func() {
		for range resizeCh {
			sendResize(w)
		}
	}()

	return <-done
}

// wsWriter sérialise les écritures : gorilla/websocket n'admet qu'un seul
// écrivain à la fois, or stdin et resize écrivent depuis deux goroutines
// (sinon panic « concurrent write », qui saute term.Restore et laisse le
// terminal en raw).
type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsWriter) send(typ string, data any) error {
	msg, err := json.Marshal(wsMsg{Type: typ, Data: data})
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.TextMessage, msg)
}

// pumpInput relaie r vers le serveur jusqu'à une erreur de lecture ou d'écriture.
func pumpInput(r io.Reader, w *wsWriter) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if err != nil {
			return
		}
		if err := w.send("input", base64.StdEncoding.EncodeToString(buf[:n])); err != nil {
			return
		}
	}
}

// readLoop relaie les frames serveur vers stdout/stderr jusqu'à la fin de
// session : nil à la fermeture du socket ou sur une frame de fin, l'erreur
// d'une frame illisible sinon.
func readLoop(conn *websocket.Conn, stdout, stderr io.Writer) error {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return nil
		}
		if end, err := handleFrame(raw, stdout, stderr); end || err != nil {
			return err
		}
	}
}

// handleFrame traite une frame serveur → client. Les deux transports n'ont
// pas la même forme de `data` : api/modules/remote/routes/ssh.js d'un côté,
// de l'autre api/modules/inventory/routes/agent.js (1445-1478) qui relaie
// tel quel vers le socket console ce qu'émet agent-go/console.go :
//
//	         SSH        console-via-agent
//	data     "<b64>"    { b64 }
//	error    "msg"      "msg" (refus serveur) ou { message } (agent)
//	status   "msg"      "msg"
//	opened   —          { pid }
//	exit     —          { reason }
//
// end : la session est terminée. err : frame illisible — on coupe la session
// plutôt que de laisser l'admin taper à l'aveugle dans un shell SYSTEM dont
// la sortie serait perdue.
func handleFrame(raw []byte, stdout, stderr io.Writer) (end bool, err error) {
	var msg struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Type == "" {
		return true, fmt.Errorf("frame serveur illisible (%.80q) — CLI incompatible avec le serveur, à mettre à jour ?", raw)
	}
	switch msg.Type {
	case "data":
		b, err := decodeData(msg.Data)
		if err != nil {
			return true, fmt.Errorf("frame « data » illisible (%v) — CLI incompatible avec le serveur, à mettre à jour ?", err)
		}
		stdout.Write(b)
	case "status":
		fmt.Fprintf(stderr, "\r\n[%s]\r\n", frameText(msg.Data))
	case "opened":
		var o map[string]any
		_ = json.Unmarshal(msg.Data, &o)
		if pid, ok := o["pid"].(float64); ok && pid > 0 {
			fmt.Fprintf(stderr, "\r\n[Console ouverte (pid %d)]\r\n", int(pid))
		} else {
			fmt.Fprint(stderr, "\r\n[Console ouverte]\r\n")
		}
	case "error":
		fmt.Fprintf(stderr, "\r\n[erreur] %s\r\n", frameText(msg.Data))
		return true, nil
	case "exit":
		// Le serveur ferme le socket juste après (routes/agent.js) : on
		// continue de lire, c'est la fermeture qui termine la session.
		fmt.Fprintf(stderr, "\r\n[Session terminée : %s]\r\n", exitReason(msg.Data))
	case "close":
		return true, nil
	}
	// Type inconnu : ignoré (serveur plus récent), comme côté agent.
	return false, nil
}

// decodeData — SSH : "<b64>" ; console-via-agent : { b64:"<b64>" }.
func decodeData(data json.RawMessage) ([]byte, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	var b64 string
	switch d := v.(type) {
	case string:
		b64 = d
	case map[string]any:
		s, ok := d["b64"].(string)
		if !ok {
			return nil, fmt.Errorf("objet sans champ b64 : %.80s", data)
		}
		b64 = s
	default:
		return nil, fmt.Errorf("ni string ni objet { b64 } : %.80s", data)
	}
	return base64.StdEncoding.DecodeString(b64)
}

// frameText — texte d'une frame status/error : string, ou { message } pour
// une erreur agent. Toute autre forme est rendue brute plutôt qu'avalée.
func frameText(data json.RawMessage) string {
	var v any
	_ = json.Unmarshal(data, &v)
	switch d := v.(type) {
	case string:
		return d
	case map[string]any:
		if s, ok := d["message"].(string); ok {
			return s
		}
	}
	return string(data)
}

// exitReason — { reason } émis par l'agent ; `code` en repli, comme le browser.
func exitReason(data json.RawMessage) string {
	var o map[string]any
	_ = json.Unmarshal(data, &o)
	if s, ok := o["reason"].(string); ok && s != "" {
		return s
	}
	if c, ok := o["code"]; ok && c != nil {
		return fmt.Sprintf("code %v", c)
	}
	return "code ?"
}

func sendResize(w *wsWriter) {
	cols, rows, err := term.GetSize(int(os.Stdin.Fd()))
	if err != nil {
		return
	}
	writeResize(w, cols, rows)
}

func writeResize(w *wsWriter, cols, rows int) error {
	return w.send("resize", map[string]int{"cols": cols, "rows": rows})
}

func toWS(s string) string {
	s = strings.TrimRight(s, "/")
	s = strings.Replace(s, "https://", "wss://", 1)
	s = strings.Replace(s, "http://", "ws://", 1)
	return s
}
