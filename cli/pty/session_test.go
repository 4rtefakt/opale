package pty

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestToWS(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://opale.example.com", "wss://opale.example.com"},
		{"http://opale.example.com", "ws://opale.example.com"},
		{"https://opale.example.com/", "wss://opale.example.com"},      // trailing slash strip
		{"https://opale.example.com:3010/", "wss://opale.example.com:3010"},
		{"opale.example.com", "opale.example.com"},                      // pas de scheme → inchangé (caller doit avoir normalisé)
	}
	for _, tc := range cases {
		got := toWS(tc.in)
		if got != tc.want {
			t.Errorf("toWS(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Frames reçues par un client terminal (browser ou CLI), capturées telles
// quelles sur le code serveur réel : agent Go (consoleManager + wsWriter,
// agent-go/console.go) → routes/agent.js → routes/console.js pour la
// console-via-agent ; routes/ssh.js face à un sshd ssh2 local pour le SSH.
// Les deux transports n'ont pas la même forme de `data` : c'est ce que le
// décodeur doit accepter explicitement.
var (
	// status : api/modules/remote/routes/console.js:170 ; opened / data / exit :
	// agent-go/console.go:124-125, 141-144, 156-157 relayés par
	// api/modules/inventory/routes/agent.js:1451, 1462, 1475.
	consoleFrames = []string{
		`{"type":"status","data":"Ouverture console (powershell.exe)…"}`,
		`{"type":"opened","data":{"pid":4242}}`,
		`{"type":"data","data":{"b64":"UFMgQzpcV2luZG93c1xzeXN0ZW0zMj4g"}}`,
		`{"type":"data","data":{"b64":"aMOpbGxvDQo="}}`,
		`{"type":"exit","data":{"reason":"exit"}}`,
	}
	// agent-go/console.go:258-260 → agent.js:1468 (erreur agent, objet)
	consoleAgentError = `{"type":"error","data":{"message":"console non supportée sur cet OS (agent prod = Windows uniquement)"}}`
	// api/modules/remote/routes/console.js:103-106 (refus serveur, string)
	consoleServerError = `{"type":"error","data":"Nonce invalide ou déjà utilisé"}`
	// agent-go/console.go:151-157 (PTY crash) → agent.js:1475
	consoleExitError = `{"type":"exit","data":{"reason":"read /dev/ptmx: input/output error"}}`

	// api/modules/remote/routes/ssh.js:119-135
	sshFrames = []string{
		`{"type":"status","data":"Connexion à PC-CAP-SSH (127.0.0.1)..."}`,
		`{"type":"status","data":"Connecté"}`,
		`{"type":"data","data":"QzpcVXNlcnNcb3BhbGU+IGjDqWxsbw0K"}`,
		`{"type":"data","data":"c3RkZXJyLWxpbmUNCg=="}`,
	}
	// ssh.js:165
	sshError = `{"type":"error","data":"SSH : connect ECONNREFUSED 127.0.0.1:1"}`
)

type frameRun struct {
	stdout, stderr string
	end            bool
	err            error
}

// feed rejoue une séquence de frames comme la goroutine de lecture de Connect :
// arrêt à la première frame qui termine la session ou qui est rejetée.
func feed(frames ...string) frameRun {
	var out, errOut bytes.Buffer
	var r frameRun
	for _, f := range frames {
		r.end, r.err = handleFrame([]byte(f), &out, &errOut)
		if r.end || r.err != nil {
			break
		}
	}
	r.stdout, r.stderr = out.String(), errOut.String()
	return r
}

func TestHandleFrame_ConsoleTransport(t *testing.T) {
	r := feed(consoleFrames...)
	if r.err != nil || r.end {
		t.Fatalf("session console interrompue : end=%v err=%v", r.end, r.err)
	}
	if want := "PS C:\\Windows\\system32> héllo\r\n"; r.stdout != want {
		t.Errorf("sortie console = %q, want %q", r.stdout, want)
	}
	for _, want := range []string{
		"[Ouverture console (powershell.exe)…]",
		"[Console ouverte (pid 4242)]",
		"[Session terminée : exit]",
	} {
		if !strings.Contains(r.stderr, want) {
			t.Errorf("stderr = %q, doit contenir %q", r.stderr, want)
		}
	}

	r = feed(consoleExitError)
	if !strings.Contains(r.stderr, "[Session terminée : read /dev/ptmx: input/output error]") {
		t.Errorf("motif de fin non affiché : %q", r.stderr)
	}

	for _, tc := range []struct{ frame, want string }{
		{consoleAgentError, "[erreur] console non supportée sur cet OS (agent prod = Windows uniquement)"},
		{consoleServerError, "[erreur] Nonce invalide ou déjà utilisé"},
	} {
		r = feed(tc.frame)
		if !r.end || r.err != nil {
			t.Errorf("%s : end=%v err=%v, want end=true err=nil", tc.frame, r.end, r.err)
		}
		if !strings.Contains(r.stderr, tc.want) {
			t.Errorf("%s : stderr = %q, doit contenir %q", tc.frame, r.stderr, tc.want)
		}
		if r.stdout != "" {
			t.Errorf("%s : rien ne doit partir sur stdout, got %q", tc.frame, r.stdout)
		}
	}
}

func TestHandleFrame_SSHTransport(t *testing.T) {
	r := feed(sshFrames...)
	if r.err != nil || r.end {
		t.Fatalf("session SSH interrompue : end=%v err=%v", r.end, r.err)
	}
	if want := "C:\\Users\\opale> héllo\r\nstderr-line\r\n"; r.stdout != want {
		t.Errorf("sortie SSH = %q, want %q", r.stdout, want)
	}
	for _, want := range []string{"[Connexion à PC-CAP-SSH (127.0.0.1)...]", "[Connecté]"} {
		if !strings.Contains(r.stderr, want) {
			t.Errorf("stderr = %q, doit contenir %q", r.stderr, want)
		}
	}

	r = feed(sshError)
	if !r.end || r.err != nil {
		t.Errorf("erreur SSH : end=%v err=%v, want end=true err=nil", r.end, r.err)
	}
	if want := "[erreur] SSH : connect ECONNREFUSED 127.0.0.1:1"; !strings.Contains(r.stderr, want) {
		t.Errorf("stderr = %q, doit contenir %q", r.stderr, want)
	}
}

// Une frame illisible ne doit jamais disparaître en silence : une sortie
// perdue laisserait l'admin taper à l'aveugle dans un shell SYSTEM.
func TestHandleFrame_MalformedFramesSurfaceAnError(t *testing.T) {
	for _, f := range []string{
		`pas du json`,
		`{"type":"data","data":{"text":"coucou"}}`,
		`{"type":"data","data":{"b64":42}}`,
		`{"type":"data","data":"%%%pas-du-base64"}`,
		`{"type":"data","data":{"b64":"%%%"}}`,
		`{"type":"data","data":42}`,
		`{"type":"data"}`,
	} {
		r := feed(f)
		if r.err == nil {
			t.Errorf("%s : erreur attendue, got nil (stdout=%q stderr=%q)", f, r.stdout, r.stderr)
		}
	}

	// Erreur de forme inconnue : rendue brute plutôt qu'avalée.
	r := feed(`{"type":"error","data":{"code":"E42"}}`)
	if !r.end || !strings.Contains(r.stderr, `[erreur] {"code":"E42"}`) {
		t.Errorf("erreur inconnue : end=%v stderr=%q", r.end, r.stderr)
	}

	// Type inconnu (serveur plus récent) : ignoré, pas une erreur.
	r = feed(`{"type":"futur","data":{"x":1}}`)
	if r.err != nil || r.end || r.stdout != "" || r.stderr != "" {
		t.Errorf("type inconnu : %+v, want ignoré", r)
	}
}

// dialTestWS ouvre une connexion cliente vers un serveur httptest+gorilla
// dont le côté serveur est piloté par serve (pas de TTY nécessaire).
func dialTestWS(t *testing.T, serve func(c *websocket.Conn)) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(rw, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		serve(c)
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// Resize (SIGWINCH) et frappe écrivent en même temps sur la connexion : sans
// sérialisation, gorilla panique (« concurrent write to websocket
// connection ») et `go test -race` signale une DATA RACE.
func TestWSWriter_ConcurrentResizeAndInput(t *testing.T) {
	const n = 300
	got := make(chan map[string]int, 1)
	conn := dialTestWS(t, func(c *websocket.Conn) {
		counts := map[string]int{}
		for {
			_, raw, err := c.ReadMessage()
			if err != nil {
				break
			}
			var m wsMsg
			if json.Unmarshal(raw, &m) != nil {
				counts["invalide"]++
				continue
			}
			counts[m.Type]++
		}
		got <- counts
	})
	w := &wsWriter{conn: conn}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pumpInput(strings.NewReader(strings.Repeat("x", 4096*n)), w)
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < n; i++ {
			if err := writeResize(w, 80+i%10, 24); err != nil {
				t.Errorf("resize %d : %v", i, err)
				return
			}
		}
	}()
	wg.Wait()
	conn.Close()

	select {
	case counts := <-got:
		if counts["input"] != n || counts["resize"] != n || counts["invalide"] != 0 {
			t.Errorf("frames reçues = %v, want %d input + %d resize intactes", counts, n, n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveur de test : pas de fin de lecture")
	}
}
