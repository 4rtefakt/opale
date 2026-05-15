package pty

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
	"golang.org/x/term"
)

type wsMsg struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Connect opens a PTY WebSocket session (used by both console and ssh commands).
// serverURL is the base HTTP/HTTPS URL of the opale server.
// wsPath is the path + query string (e.g. /api/console/:id?nonce=...).
// The protocol: send { type:"input", data:"<b64>" } / { type:"resize", data:{cols,rows} }
//               recv { type:"data",  data:"<b64>" } / { type:"status"|"error"|"close", data:"..." }
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

	// Initial size
	sendResize(conn)

	// SIGWINCH
	resizeCh := make(chan os.Signal, 1)
	signal.Notify(resizeCh, syscall.SIGWINCH)
	defer signal.Stop(resizeCh)

	done := make(chan error, 1)

	// server → stdout
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				done <- nil
				return
			}
			var msg struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "data":
				var b64 string
				if err := json.Unmarshal(msg.Data, &b64); err == nil {
					if decoded, err := base64.StdEncoding.DecodeString(b64); err == nil {
						os.Stdout.Write(decoded)
					}
				}
			case "status":
				var s string
				if json.Unmarshal(msg.Data, &s) == nil {
					fmt.Fprintf(os.Stderr, "\r\n[%s]\r\n", s)
				}
			case "error":
				var s string
				if json.Unmarshal(msg.Data, &s) == nil {
					fmt.Fprintf(os.Stderr, "\r\n[erreur] %s\r\n", s)
				}
				done <- nil
				return
			case "close":
				done <- nil
				return
			}
		}
	}()

	// stdin → server
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if err != nil {
				done <- nil
				return
			}
			b64 := base64.StdEncoding.EncodeToString(buf[:n])
			msg, _ := json.Marshal(wsMsg{Type: "input", Data: b64})
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				done <- nil
				return
			}
		}
	}()

	// resize
	go func() {
		for range resizeCh {
			sendResize(conn)
		}
	}()

	return <-done
}

func sendResize(conn *websocket.Conn) {
	cols, rows, err := term.GetSize(int(os.Stdin.Fd()))
	if err != nil {
		return
	}
	msg, _ := json.Marshal(wsMsg{
		Type: "resize",
		Data: map[string]int{"cols": cols, "rows": rows},
	})
	conn.WriteMessage(websocket.TextMessage, msg)
}

func toWS(s string) string {
	s = strings.TrimRight(s, "/")
	s = strings.Replace(s, "https://", "wss://", 1)
	s = strings.Replace(s, "http://", "ws://", 1)
	return s
}
