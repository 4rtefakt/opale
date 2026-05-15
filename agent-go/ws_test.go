package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeServer expose un endpoint WS qui :
//   - vérifie le Bearer attendu (renvoie 401 sinon)
//   - lit la frame hello et la pousse dans un channel pour assertion
//   - envoie un welcome
//   - envoie un ping et attend le pong
//   - close
//
// Quand on parle "WS bidon" : pas de DB, pas de heartbeat timer, juste de
// quoi prouver que l'interop protocolaire tient.
type fakeServer struct {
	expectedToken string
	gotHello      chan map[string]any
	gotPong       chan map[string]any
	connCount     atomic.Int32
}

func (s *fakeServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+s.expectedToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: []string{"*"},
		})
		if err != nil {
			t.Logf("ws accept : %v", err)
			return
		}
		s.connCount.Add(1)
		defer c.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		// Lecture du hello.
		_, raw, err := c.Read(ctx)
		if err != nil {
			t.Logf("read hello : %v", err)
			return
		}
		var fr wsFrame
		if err := json.Unmarshal(raw, &fr); err != nil {
			t.Logf("parse hello : %v", err)
			return
		}
		if fr.Type != "hello" {
			t.Logf("attendu hello, reçu %q", fr.Type)
			return
		}
		var helloData map[string]any
		_ = json.Unmarshal(fr.Data, &helloData)
		s.gotHello <- helloData

		// Welcome.
		welcome, _ := json.Marshal(map[string]any{
			"type": "welcome",
			"data": map[string]any{
				"server_time":      time.Now().Format(time.RFC3339),
				"ping_interval_s":  30,
			},
		})
		_ = c.Write(ctx, websocket.MessageText, welcome)

		// Ping.
		ping, _ := json.Marshal(map[string]any{
			"type": "ping",
			"data": map[string]any{"ts": time.Now().UnixMilli()},
		})
		_ = c.Write(ctx, websocket.MessageText, ping)

		// Pong attendu en retour.
		_, raw, err = c.Read(ctx)
		if err != nil {
			t.Logf("read pong : %v", err)
			return
		}
		var pongFr wsFrame
		if err := json.Unmarshal(raw, &pongFr); err != nil {
			t.Logf("parse pong : %v", err)
			return
		}
		if pongFr.Type != "pong" {
			t.Logf("attendu pong, reçu %q", pongFr.Type)
			return
		}
		var pongData map[string]any
		_ = json.Unmarshal(pongFr.Data, &pongData)
		s.gotPong <- pongData

		// Bye pour terminer proprement.
		bye, _ := json.Marshal(map[string]any{"type": "bye"})
		_ = c.Write(ctx, websocket.MessageText, bye)
		_ = c.Close(websocket.StatusNormalClosure, "test-done")
	}
}

func TestWSClient_HandshakeAndHeartbeat(t *testing.T) {
	fs := &fakeServer{
		expectedToken: "tok-deadbeef",
		gotHello:      make(chan map[string]any, 1),
		gotPong:       make(chan map[string]any, 1),
	}
	srv := httptest.NewServer(fs.handler(t))
	defer srv.Close()

	cfg := &Config{
		Token: "tok-deadbeef",
		URL:   srv.URL, // http://127.0.0.1:NNNNN
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- runWSSession(ctx, cfg) }()

	select {
	case hello := <-fs.gotHello:
		if hello["agent_version"] != AgentVersion {
			t.Fatalf("agent_version : attendu %q, reçu %v", AgentVersion, hello["agent_version"])
		}
		if caps, ok := hello["capabilities"].([]any); !ok || len(caps) != 0 {
			t.Fatalf("capabilities : attendu [], reçu %v", hello["capabilities"])
		}
	case <-ctx.Done():
		t.Fatal("timeout en attendant hello")
	}

	select {
	case pong := <-fs.gotPong:
		if _, ok := pong["ts"]; !ok {
			t.Fatalf("pong sans ts : %v", pong)
		}
	case <-ctx.Done():
		t.Fatal("timeout en attendant pong")
	}

	// La session doit se terminer quand le serveur envoie bye.
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "server sent bye") {
			t.Fatalf("attendu erreur 'server sent bye', reçu : %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timeout en attendant fin de session")
	}
}

func TestWSClient_RejectsBadToken(t *testing.T) {
	fs := &fakeServer{
		expectedToken: "tok-correct",
		gotHello:      make(chan map[string]any, 1),
		gotPong:       make(chan map[string]any, 1),
	}
	srv := httptest.NewServer(fs.handler(t))
	defer srv.Close()

	cfg := &Config{
		Token: "tok-WRONG",
		URL:   srv.URL,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := runWSSession(ctx, cfg)
	if err == nil {
		t.Fatal("attendu erreur de dial avec mauvais token")
	}
	if fs.connCount.Load() != 0 {
		t.Fatalf("le serveur n'aurait pas dû accepter le upgrade, conn=%d", fs.connCount.Load())
	}
}

func TestBuildWSURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://rmm.example.com", "wss://rmm.example.com/api/agent/ws"},
		{"https://rmm.example.com/", "wss://rmm.example.com/api/agent/ws"},
		{"https://rmm.example.com/api", "wss://rmm.example.com/api/agent/ws"},
		{"http://localhost:3010", "ws://localhost:3010/api/agent/ws"},
	}
	for _, c := range cases {
		got, err := buildWSURL(c.in)
		if err != nil {
			t.Errorf("buildWSURL(%q) erreur : %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("buildWSURL(%q) = %q, attendu %q", c.in, got, c.want)
		}
	}
}

func TestBuildWSURL_RejectsBadScheme(t *testing.T) {
	_, err := buildWSURL("ftp://nope")
	if err == nil {
		t.Fatal("attendu erreur pour scheme ftp")
	}
}
