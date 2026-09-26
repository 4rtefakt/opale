package pty

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
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

// Frames reçues par un client terminal (browser ou CLI) : forme identique au
// code serveur (enveloppes et champs relevés en faisant tourner
// agent-go/console.go, routes/agent.js, routes/console.js et routes/ssh.js),
// contenu illustratif (invite Windows à côté d'erreurs d'un agent Linux,
// qui refuse les consoles : console_other.go). Les deux transports n'ont pas
// la même forme de `data` : c'est ce que le décodeur doit accepter
// explicitement.
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
	// exit (dernière frame) termine la session, sans erreur.
	r := feed(consoleFrames...)
	if r.err != nil || !r.end {
		t.Fatalf("session console : end=%v err=%v, want end=true err=nil", r.end, r.err)
	}
	if r = feed(consoleFrames[:len(consoleFrames)-1]...); r.end || r.err != nil {
		t.Fatalf("session console interrompue avant exit : end=%v err=%v", r.end, r.err)
	}
	r = feed(consoleFrames...)
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
	// Repli sur `code` quand l'exit n'a pas de reason, comme le browser.
	for frame, want := range map[string]string{
		`{"type":"exit","data":{"code":1}}`: "[Session terminée : code 1]",
		`{"type":"exit","data":{}}`:         "[Session terminée : code ?]",
	} {
		if r = feed(frame); !strings.Contains(r.stderr, want) {
			t.Errorf("%s : stderr = %q, doit contenir %q", frame, r.stderr, want)
		}
	}

	// error : fin de session en erreur (code de sortie non nul), message
	// remonté tel quel pour être affiché une seule fois, par cobra.
	for _, tc := range []struct{ frame, want string }{
		{consoleAgentError, "console non supportée sur cet OS (agent prod = Windows uniquement)"},
		{consoleServerError, "Nonce invalide ou déjà utilisé"},
	} {
		r = feed(tc.frame)
		if !r.end || r.err == nil || r.err.Error() != tc.want {
			t.Errorf("%s : end=%v err=%v, want end=true err=%q", tc.frame, r.end, r.err, tc.want)
		}
		if strings.Contains(r.stderr, tc.want) || r.stdout != "" {
			t.Errorf("%s : message affiché en double (stdout=%q stderr=%q)", tc.frame, r.stdout, r.stderr)
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
	want := "SSH : connect ECONNREFUSED 127.0.0.1:1"
	if !r.end || r.err == nil || r.err.Error() != want {
		t.Errorf("erreur SSH : end=%v err=%v, want end=true err=%q", r.end, r.err, want)
	}
	if strings.Contains(r.stderr, want) {
		t.Errorf("message affiché en double : stderr = %q", r.stderr)
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
		`{"type":"data","data":null}`,
		`{"type":"data"}`,
		`{"data":"x"}`,
	} {
		r := feed(f)
		if r.err == nil {
			t.Errorf("%s : erreur attendue, got nil (stdout=%q stderr=%q)", f, r.stdout, r.stderr)
		}
	}

	// Erreur de forme inconnue : rendue brute plutôt qu'avalée.
	r := feed(`{"type":"error","data":{"code":"E42"}}`)
	if !r.end || r.err == nil || r.err.Error() != `{"code":"E42"}` {
		t.Errorf("erreur inconnue : end=%v err=%v", r.end, r.err)
	}
	if r = feed(`{"type":"error"}`); r.err == nil || r.err.Error() != "erreur serveur sans détail" {
		t.Errorf("erreur sans data : err=%v", r.err)
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

// serveFrames : côté serveur de test, envoie les frames puis une frame de
// fermeture (closePayload vide = `socket.close()` sans argument, comme
// ssh.js), et attend que le client ait fini.
func serveFrames(frames []string, closePayload []byte) func(c *websocket.Conn) {
	return func(c *websocket.Conn) {
		for _, f := range frames {
			if c.WriteMessage(websocket.TextMessage, []byte(f)) != nil {
				return
			}
		}
		_ = c.WriteMessage(websocket.CloseMessage, closePayload)
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}
}

// runReadLoop fait tourner la vraie boucle de lecture sur un socket gorilla.
func runReadLoop(t *testing.T, frames []string, closePayload []byte) frameRun {
	t.Helper()
	var out, errOut bytes.Buffer
	err := runReadLoopTo(t, frames, closePayload, &out, &errOut)
	return frameRun{stdout: out.String(), stderr: errOut.String(), err: err}
}

func runReadLoopTo(t *testing.T, frames []string, closePayload []byte, stdout, stderr io.Writer) error {
	t.Helper()
	conn := dialTestWS(t, serveFrames(frames, closePayload))
	errc := make(chan error, 1)
	go func() { errc <- readLoop(conn, stdout, stderr) }()
	select {
	case err := <-errc:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("readLoop bloquée")
	}
	return nil
}

// Câblage réel (socket, pas de TTY) : sortie des deux transports, fin propre,
// et propagation jusqu'à l'appelant de l'erreur d'une frame illisible.
func TestReadLoop_Wiring(t *testing.T) {
	r := runReadLoop(t, consoleFrames, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "exit"))
	if r.err != nil || r.stdout != "PS C:\\Windows\\system32> héllo\r\n" ||
		!strings.Contains(r.stderr, "[Session terminée : exit]") {
		t.Errorf("console : %+v", r)
	}

	r = runReadLoop(t, sshFrames, []byte{})
	if r.err != nil || r.stdout != "C:\\Users\\opale> héllo\r\nstderr-line\r\n" {
		t.Errorf("ssh : %+v", r)
	}

	r = runReadLoop(t, []string{
		consoleFrames[0],
		`{"type":"data","data":null}`,
		`{"type":"data","data":{"b64":"QVBSRVM="}}`, // "APRES"
	}, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "exit"))
	if r.err == nil || !strings.Contains(r.err.Error(), "illisible") {
		t.Errorf("frame illisible : err = %v, want erreur remontée à l'appelant", r.err)
	}
	if strings.Contains(r.stdout, "APRES") {
		t.Errorf("la session aurait dû s'arrêter à la frame illisible : stdout = %q", r.stdout)
	}
}

// Socket fermé par le serveur avec un motif, sans frame error/exit : la CLI
// doit dire pourquoi (comme le « Déconnecté : <motif> » du browser) et sortir
// en erreur. Motifs de api/modules/remote/lib/console-sessions.js close().
func TestReadLoop_CloseReasonIsReported(t *testing.T) {
	opened := consoleFrames[:3] // status, opened, data (invite sans retour à la ligne)
	for _, reason := range []string{"taken-over", "agent-disconnected", "server-shutdown", "browser-frame-too-large"} {
		// Un seul flux, comme le terminal où stdout et stderr s'entrelacent.
		var term bytes.Buffer
		err := runReadLoopTo(t, opened, websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason), &term, &term)
		if err == nil || err.Error() != "déconnecté : "+reason {
			t.Errorf("%s : err = %v, want « déconnecté : %s »", reason, err, reason)
		}
		if !strings.HasSuffix(term.String(), "PS C:\\Windows\\system32> \r\n") {
			t.Errorf("%s : terminal = %q, doit finir par un retour à la ligne avant le « Error: » de cobra", reason, term.String())
		}
	}

	// Fin normale : exit puis fermeture avec le même motif → déjà expliquée,
	// pas de « déconnecté » en plus, code 0.
	r := runReadLoop(t, consoleFrames, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "exit"))
	if r.err != nil || strings.Contains(r.stderr, "déconnecté") {
		t.Errorf("exit puis close : %+v, want fin normale", r)
	}
	// SSH : `socket.close()` sans motif (ssh.js) → fin normale.
	if r = runReadLoop(t, sshFrames, []byte{}); r.err != nil {
		t.Errorf("ssh close sans motif : err = %v", r.err)
	}
}

// Frame error en cours de session (agent puis close 'agent-error', ou SSH) :
// code de sortie non nul, message affiché une seule fois (par cobra), et
// retour à la ligne pour que « Error: » ne tombe pas au milieu de l'invite.
func TestReadLoop_ErrorFrameExitsNonZero(t *testing.T) {
	for _, tc := range []struct {
		name   string
		frames []string
		close  []byte
		want   string
	}{
		{"console", []string{consoleFrames[0], consoleFrames[2], consoleAgentError},
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent-error"),
			"console non supportée sur cet OS (agent prod = Windows uniquement)"},
		{"ssh", []string{sshFrames[0], `{"type":"data","data":"UFM+IA=="}`, sshError}, // "PS> "
			[]byte{}, "SSH : connect ECONNREFUSED 127.0.0.1:1"},
	} {
		var term bytes.Buffer
		err := runReadLoopTo(t, tc.frames, tc.close, &term, &term)
		if err == nil || err.Error() != tc.want {
			t.Errorf("%s : err = %v, want %q", tc.name, err, tc.want)
		}
		if strings.Contains(term.String(), tc.want) {
			t.Errorf("%s : message affiché en double : %q", tc.name, term.String())
		}
		if !strings.HasSuffix(term.String(), "> \r\n") {
			t.Errorf("%s : terminal = %q, doit finir par un retour à la ligne", tc.name, term.String())
		}
	}
}

// firstWriteWriter signale sa première écriture : le serveur de test attend
// que la sortie soit affichée avant de couper la connexion.
type firstWriteWriter struct {
	buf   bytes.Buffer
	once  sync.Once
	first chan struct{}
}

func (w *firstWriteWriter) Write(p []byte) (int, error) {
	n, err := w.buf.Write(p)
	w.once.Do(func() { close(w.first) })
	return n, err
}

// Connexion coupée sans frame close : FIN (gorilla synthétise un 1006
// « unexpected EOF ») comme RST (NAT, VPN, proxy : net.OpError) → erreur
// explicite et code non nul, après un retour à la ligne.
func TestReadLoop_ConnectionLost(t *testing.T) {
	for _, tc := range []struct {
		name string
		rst  bool
	}{{"FIN", false}, {"RST", true}} {
		term := &firstWriteWriter{first: make(chan struct{})}
		conn := dialTestWS(t, func(c *websocket.Conn) {
			_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"data","data":"UFM+IA=="}`)) // "PS> "
			<-term.first
			if tc.rst {
				_ = c.UnderlyingConn().(*net.TCPConn).SetLinger(0)
			}
			// Retour du handler : Close() sans frame close → FIN, ou RST.
		})
		errc := make(chan error, 1)
		go func() { errc <- readLoop(conn, term, term) }()
		var err error
		select {
		case err = <-errc:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s : readLoop bloquée", tc.name)
		}
		if err == nil || !strings.HasPrefix(err.Error(), "connexion au serveur perdue") ||
			(!tc.rst && err.Error() != "connexion au serveur perdue") {
			t.Errorf("%s : err = %v, want « connexion au serveur perdue »", tc.name, err)
		}
		if got := term.buf.String(); got != "PS> \r\n" {
			t.Errorf("%s : terminal = %q, want %q", tc.name, got, "PS> \r\n")
		}
	}
}

// Câblage de runSession (ce que Connect fait tourner une fois le terminal en
// raw) : la frappe part en frame input, la sortie arrive sur stdout, et la
// fin décidée par la lecture remonte jusqu'à l'appelant.
func TestRunSession_Wiring(t *testing.T) {
	gotInput := make(chan string, 1)
	conn := dialTestWS(t, func(c *websocket.Conn) {
		_, raw, err := c.ReadMessage()
		if err != nil {
			return
		}
		var m struct{ Type, Data string }
		_ = json.Unmarshal(raw, &m)
		gotInput <- m.Type + ":" + m.Data
		for _, f := range consoleFrames[:3] { // status, opened, data
			_ = c.WriteMessage(websocket.TextMessage, []byte(f))
		}
		_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "taken-over"))
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	})
	// stdin : une frappe, puis bloqué comme un terminal où l'on ne tape plus.
	pr, pw := io.Pipe()
	t.Cleanup(func() { pw.Close() })
	stdin := io.MultiReader(strings.NewReader("dir\r"), pr)

	var out, errOut bytes.Buffer
	errc := make(chan error, 1)
	go func() { errc <- runSession(conn, &wsWriter{conn: conn}, stdin, &out, &errOut) }()
	var err error
	select {
	case err = <-errc:
	case <-time.After(5 * time.Second):
		t.Fatal("runSession bloquée")
	}

	select {
	case got := <-gotInput:
		if got != "input:ZGlyDQ==" { // base64("dir\r")
			t.Errorf("frame envoyée = %q, want input:ZGlyDQ==", got)
		}
	case <-time.After(time.Second):
		t.Error("aucune frame input reçue : stdin non relayé")
	}
	if out.String() != "PS C:\\Windows\\system32> " {
		t.Errorf("stdout = %q", out.String())
	}
	if err == nil || err.Error() != "déconnecté : taken-over" {
		t.Errorf("err = %v, want « déconnecté : taken-over »", err)
	}
}

// La lecture fait foi : une touche frappée au moment de la fermeture fait
// échouer l'écriture (stdin fini) avant que readLoop ait remonté le motif.
func TestWaitEnd_ReadResultIsAuthoritative(t *testing.T) {
	chans := func() (chan error, chan error) { return make(chan error, 1), make(chan error, 1) }
	later := func(ch chan error, err error) {
		go func() { time.Sleep(50 * time.Millisecond); ch <- err }()
	}
	motif := errors.New("déconnecté : taken-over")

	// Écriture refusée d'abord, motif de fermeture juste après : le motif gagne.
	readDone, inputDone := chans()
	inputDone <- websocket.ErrCloseSent
	later(readDone, motif)
	if err := waitEnd(readDone, inputDone, 5*time.Second); err != motif {
		t.Errorf("écriture refusée puis motif : err = %v, want %v", err, motif)
	}

	// Même course, fin normale côté lecture : pas d'erreur inventée.
	readDone, inputDone = chans()
	inputDone <- websocket.ErrCloseSent
	later(readDone, nil)
	if err := waitEnd(readDone, inputDone, 5*time.Second); err != nil {
		t.Errorf("écriture refusée puis fin normale : err = %v, want nil", err)
	}

	// stdin fermé (terminal perdu) : fin sans erreur, sans attendre la lecture.
	readDone, inputDone = chans()
	inputDone <- nil
	start := time.Now()
	if err := waitEnd(readDone, inputDone, 5*time.Second); err != nil || time.Since(start) > time.Second {
		t.Errorf("stdin fermé : err = %v après %v, want nil immédiat", err, time.Since(start))
	}

	// Écriture refusée et lecture muette : pas de blocage, perte de connexion.
	readDone, inputDone = chans()
	inputDone <- errors.New("write: broken pipe")
	if err := waitEnd(readDone, inputDone, 50*time.Millisecond); err == nil ||
		err.Error() != "connexion au serveur perdue : write: broken pipe" {
		t.Errorf("lecture muette : err = %v", err)
	}
}
