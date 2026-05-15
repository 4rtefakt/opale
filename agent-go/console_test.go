package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Test du dispatch console.* côté agent. Sur Mac/Linux, spawnConsole renvoie
// une erreur (stub) — on vérifie alors que l'agent répond proprement par
// console.error. Sur Windows, on skip (ConPTY a besoin d'un Windows réel) ;
// les tests d'intégration ConPTY sont à faire en environnement Windows.

type consoleFakeServer struct {
	token      string
	frames     chan wsFrame
	closeAfter int // si > 0, ferme après ce nombre de frames reçues de l'agent
}

func (s *consoleFakeServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+s.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
		if err != nil {
			t.Logf("accept : %v", err)
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// Goroutine de lecture qui pousse toutes les frames reçues dans le channel.
		var wg sync.WaitGroup
		wg.Add(1)
		readDone := make(chan struct{})
		go func() {
			defer wg.Done()
			defer close(readDone)
			for {
				_, raw, err := c.Read(ctx)
				if err != nil {
					return
				}
				var fr wsFrame
				if err := json.Unmarshal(raw, &fr); err != nil {
					continue
				}
				select {
				case s.frames <- fr:
				case <-ctx.Done():
					return
				}
			}
		}()

		// Welcome.
		welcome, _ := json.Marshal(map[string]any{"type": "welcome", "data": map[string]any{}})
		_ = c.Write(ctx, websocket.MessageText, welcome)

		// On attend le hello.
		<-time.After(50 * time.Millisecond)

		// console.open avec un session_id de test.
		sessID := "00000000-0000-0000-0000-000000000abc"
		openFr, _ := json.Marshal(map[string]any{
			"type": "console.open",
			"id":   sessID,
			"data": map[string]any{"shell": "powershell.exe", "cols": 80, "rows": 24},
		})
		_ = c.Write(ctx, websocket.MessageText, openFr)

		<-readDone
		wg.Wait()
	}
}

func TestConsole_DispatchOnNonWindowsAnswersError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ConPTY teste sur Windows uniquement — stub _other.go testé ici")
	}
	fs := &consoleFakeServer{
		token:  "tok-console",
		frames: make(chan wsFrame, 8),
	}
	srv := httptest.NewServer(fs.handler(t))
	defer srv.Close()

	cfg := &Config{Token: "tok-console", URL: srv.URL}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- runWSSession(ctx, cfg) }()

	var sawHello, sawError bool
	collected := []wsFrame{}
	deadline := time.After(3 * time.Second)
loop:
	for {
		select {
		case fr := <-fs.frames:
			collected = append(collected, fr)
			if fr.Type == "hello" {
				sawHello = true
				// Vérifie que la capability "console" n'est PAS annoncée hors Windows.
				var d struct {
					Capabilities []string `json:"capabilities"`
				}
				_ = json.Unmarshal(fr.Data, &d)
				for _, c := range d.Capabilities {
					if c == "console" {
						t.Fatalf("capability \"console\" annoncée sur %s — ne devrait apparaître que sur Windows", runtime.GOOS)
					}
				}
			}
			if fr.Type == "console.error" {
				sawError = true
				break loop
			}
		case <-deadline:
			break loop
		}
	}

	if !sawHello {
		t.Fatalf("hello jamais reçu (frames collectées : %v)", framesTypes(collected))
	}
	if !sawError {
		t.Fatalf("console.error attendu côté serveur de test (frames collectées : %v)", framesTypes(collected))
	}
}

func framesTypes(fs []wsFrame) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Type
	}
	return out
}
