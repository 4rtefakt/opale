package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// stubMetrics remplace la collecte réelle (échantillonnage CPU ~5 s, ping)
// le temps du test.
func stubMetrics(t *testing.T) {
	t.Helper()
	orig := collectMetricsFn
	collectMetricsFn = func() (*CheckinPayload, error) {
		return &CheckinPayload{Hostname: "PC-TEST"}, nil
	}
	t.Cleanup(func() { collectMetricsFn = orig })
}

// resultServer — faux /api/agent/checkin : enregistre chaque corps reçu et
// répond selon fail (appelé avec le numéro de la requête, à partir de 1) :
// true → réponse d'échec produite par failWith.
type resultServer struct {
	mu       sync.Mutex
	payloads []CheckinPayload
	fail     func(n int) bool
	failWith func(w http.ResponseWriter)
	onReq    func(n int) // appelé pendant la requête, avant la réponse
}

func (s *resultServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/checkin" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var p CheckinPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Errorf("payload illisible : %v", err)
		}
		s.mu.Lock()
		s.payloads = append(s.payloads, p)
		n := len(s.payloads)
		s.mu.Unlock()
		if s.onReq != nil {
			s.onReq(n)
		}
		if s.fail != nil && s.fail(n) {
			s.failWith(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"device_id":"dev-1"}`))
	}
}

func (s *resultServer) payload(t *testing.T, n int) CheckinPayload {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.payloads) < n {
		t.Fatalf("%d requête(s) reçue(s), attendu au moins %d", len(s.payloads), n)
	}
	return s.payloads[n-1]
}

func depIDs(rs []DeploymentResult) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.DeploymentID)
	}
	return out
}

func detIDs(rs []DetectionResult) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.PackageID)
	}
	return out
}

func sameIDs(a, b []string) bool {
	return strings.Join(a, ",") == strings.Join(b, ",")
}

// Un résultat de déploiement ne doit jamais être perdu parce qu'un checkin
// échoue : il repart tel quel au checkin suivant, et n'est retiré de l'état
// qu'une fois la réponse acceptée — quelle que soit la cause de l'échec.
func TestDoCheckin_FailedSendKeepsResultsUntilAcknowledged(t *testing.T) {
	stubMetrics(t)
	failures := map[string]func(w http.ResponseWriter){
		"http-500": func(w http.ResponseWriter) { http.Error(w, "boom", http.StatusInternalServerError) },
		"json-invalide": func(w http.ResponseWriter) {
			_, _ = w.Write([]byte(`{"ok":tru`))
		},
		"ok-false": func(w http.ResponseWriter) { _, _ = w.Write([]byte(`{"ok":false}`)) },
		"connexion-coupee": func(w http.ResponseWriter) {
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
		},
	}
	for name, failWith := range failures {
		t.Run(name, func(t *testing.T) {
			t.Setenv("RMM_DATA_DIR", t.TempDir())
			srv := &resultServer{fail: func(n int) bool { return n == 1 }, failWith: failWith}
			ts := httptest.NewServer(srv.handler(t))
			defer ts.Close()
			cfg := &Config{Token: "tok", URL: ts.URL}
			st := &State{
				PendingDeployments: []DeploymentResult{{DeploymentID: "dep-1", ExitCode: 0, Output: "installé"}},
				PendingDetections:  []DetectionResult{{PackageID: "pkg-1", Detected: true}},
			}

			if _, err := DoCheckin(context.Background(), cfg, st); err == nil {
				t.Fatal("1er checkin : erreur attendue")
			}
			if got := srv.payload(t, 1); !sameIDs(depIDs(got.DeploymentResults), []string{"dep-1"}) {
				t.Fatalf("1er envoi : %v", depIDs(got.DeploymentResults))
			}
			if !sameIDs(depIDs(st.PendingDeployments), []string{"dep-1"}) || !sameIDs(detIDs(st.PendingDetections), []string{"pkg-1"}) {
				t.Fatalf("résultats perdus après l'échec : dep=%v det=%v", depIDs(st.PendingDeployments), detIDs(st.PendingDetections))
			}

			if _, err := DoCheckin(context.Background(), cfg, st); err != nil {
				t.Fatalf("2e checkin : %v", err)
			}
			got := srv.payload(t, 2)
			if !sameIDs(depIDs(got.DeploymentResults), []string{"dep-1"}) || got.DeploymentResults[0].Output != "installé" {
				t.Fatalf("résultat non renvoyé à l'identique : %+v", got.DeploymentResults)
			}
			if !sameIDs(detIDs(got.DetectionResults), []string{"pkg-1"}) {
				t.Fatalf("détection non renvoyée : %v", detIDs(got.DetectionResults))
			}
			if len(st.PendingDeployments) != 0 || len(st.PendingDetections) != 0 {
				t.Fatalf("résultats acquittés encore en file : %+v %+v", st.PendingDeployments, st.PendingDetections)
			}
		})
	}
}

// Redémarrage entre l'échec et le renvoi : le state.json écrit après
// l'échec (CheckRollback, cycle suivant…) garde les résultats, qui repartent
// depuis l'état rechargé ; une fois acquittés, ils disparaissent aussi du
// fichier.
func TestDoCheckin_ResultsSurviveRestartUntilAcknowledged(t *testing.T) {
	stubMetrics(t)
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	srv := &resultServer{
		fail:     func(n int) bool { return n == 1 },
		failWith: func(w http.ResponseWriter) { http.Error(w, "indisponible", http.StatusBadGateway) },
	}
	ts := httptest.NewServer(srv.handler(t))
	defer ts.Close()
	cfg := &Config{Token: "tok", URL: ts.URL}

	// Fenêtre post-update : CheckRollback compte l'échec et sauvegarde
	// l'état (cas réel d'écriture de state.json juste après un échec).
	st := &State{
		PendingDeployments: []DeploymentResult{{DeploymentID: "dep-1", ExitCode: 0, Output: "ok"}},
		LastUpdateAt:       time.Now().UTC(),
		LastUpdateVersion:  AgentVersion,
	}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	_, err := DoCheckin(context.Background(), cfg, st)
	if err == nil {
		t.Fatal("erreur attendue")
	}
	CheckRollback(st, err)
	if st.FailedSinceUpdate != 1 {
		t.Fatalf("échec non compté (FailedSinceUpdate=%d)", st.FailedSinceUpdate)
	}

	restarted := LoadState()
	if !sameIDs(depIDs(restarted.PendingDeployments), []string{"dep-1"}) {
		t.Fatalf("résultat absent du state.json après l'échec : %v", depIDs(restarted.PendingDeployments))
	}
	if _, err := DoCheckin(context.Background(), cfg, restarted); err != nil {
		t.Fatalf("checkin après redémarrage : %v", err)
	}
	if got := srv.payload(t, 2); !sameIDs(depIDs(got.DeploymentResults), []string{"dep-1"}) {
		t.Fatalf("résultat non renvoyé après redémarrage : %v", depIDs(got.DeploymentResults))
	}
	_ = restarted.Save()
	if again := LoadState(); len(again.PendingDeployments) != 0 {
		t.Fatalf("résultat acquitté encore dans state.json : %+v", again.PendingDeployments)
	}
}

// Un résultat ajouté après la copie envoyée n'a pas été transmis :
// l'acquittement ne doit retirer que ce qui a été envoyé. En production,
// seule la goroutine des checkins touche State (pas de verrou) ; le
// handler ne l'écrit ici que pendant que DoCheckin attend la réponse, les
// E/S réseau ordonnant les accès (go test -race sans alerte).
func TestDoCheckin_KeepsResultsQueuedDuringRequest(t *testing.T) {
	stubMetrics(t)
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	st := &State{
		PendingDeployments: []DeploymentResult{{DeploymentID: "dep-1"}},
		PendingDetections:  []DetectionResult{{PackageID: "pkg-1"}},
	}
	srv := &resultServer{onReq: func(n int) {
		if n == 1 {
			st.PendingDeployments = append(st.PendingDeployments, DeploymentResult{DeploymentID: "dep-2"})
			st.PendingDetections = append(st.PendingDetections, DetectionResult{PackageID: "pkg-2"})
		}
	}}
	ts := httptest.NewServer(srv.handler(t))
	defer ts.Close()
	cfg := &Config{Token: "tok", URL: ts.URL}

	if _, err := DoCheckin(context.Background(), cfg, st); err != nil {
		t.Fatal(err)
	}
	if !sameIDs(depIDs(st.PendingDeployments), []string{"dep-2"}) || !sameIDs(detIDs(st.PendingDetections), []string{"pkg-2"}) {
		t.Fatalf("attendu dep-2 / pkg-2 encore en file : dep=%v det=%v", depIDs(st.PendingDeployments), detIDs(st.PendingDetections))
	}
	if _, err := DoCheckin(context.Background(), cfg, st); err != nil {
		t.Fatal(err)
	}
	if got := srv.payload(t, 2); !sameIDs(depIDs(got.DeploymentResults), []string{"dep-2"}) || !sameIDs(detIDs(got.DetectionResults), []string{"pkg-2"}) {
		t.Fatalf("2e envoi : dep=%v det=%v", depIDs(got.DeploymentResults), detIDs(got.DetectionResults))
	}
	if len(st.PendingDeployments) != 0 || len(st.PendingDetections) != 0 {
		t.Fatalf("file non vidée : %+v %+v", st.PendingDeployments, st.PendingDetections)
	}
}

// Les résultats n'étant plus abandonnés sur erreur, un corps refusé pour sa
// taille (413) bloquerait tous les checkins suivants : sorties tronquées et
// lot borné, le reste part au checkin suivant.
func TestDoCheckin_ResultsBatchBoundedBelowBodyLimit(t *testing.T) {
	stubMetrics(t)
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	var bodies []int
	var mu sync.Mutex
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, len(raw))
		mu.Unlock()
		if len(raw) > 1024*1024 { // limite de corps par défaut de Fastify
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	cfg := &Config{Token: "tok", URL: ts.URL}

	huge := strings.Repeat("é", 2*1024*1024) // 4 Mio, caractères de 2 octets
	st := &State{}
	for _, id := range []string{"dep-1", "dep-2", "dep-3", "dep-4", "dep-5", "dep-6", "dep-7", "dep-8", "dep-9", "dep-10", "dep-11", "dep-12"} {
		st.PendingDeployments = append(st.PendingDeployments, DeploymentResult{DeploymentID: id, Output: "début " + huge + " fin"})
	}

	for i := 0; len(st.PendingDeployments) > 0; i++ {
		if i > 10 {
			t.Fatalf("file jamais vidée : %d résultats restants", len(st.PendingDeployments))
		}
		if _, err := DoCheckin(context.Background(), cfg, st); err != nil {
			t.Fatalf("checkin %d : %v", i+1, err)
		}
	}
	if len(bodies) < 2 {
		t.Fatalf("attendu plusieurs lots, %d checkin(s)", len(bodies))
	}

	b := pendingDeploymentBatch(&State{PendingDeployments: []DeploymentResult{{DeploymentID: "d", Output: "début " + huge + " fin"}}})
	out := b[0].Output
	if len(out) > maxResultOutputBytes || !utf8.ValidString(out) ||
		!strings.HasPrefix(out, "début ") || !strings.HasSuffix(out, " fin") || !strings.Contains(out, "sortie tronquée") {
		t.Fatalf("sortie tronquée incorrecte : %d octets, UTF-8 valide=%v", len(out), utf8.ValidString(out))
	}
	if short := pendingDeploymentBatch(&State{PendingDeployments: []DeploymentResult{{Output: "ok"}}}); short[0].Output != "ok" {
		t.Fatalf("sortie courte modifiée : %q", short[0].Output)
	}
}

// truncateMiddle coupe début ET fin sur des frontières de caractères :
// caractères de 1 à 4 octets, décalés de 0 à 3 octets (en tête ou en
// queue), pour que chaque coupure tombe à toutes les positions possibles
// à l'intérieur d'un caractère.
func TestTruncateMiddle_UTF8BoundariesBothSides(t *testing.T) {
	const limit = 101
	for _, ch := range []string{"a", "é", "€", "😀"} {
		for headPad := 0; headPad < 4; headPad++ {
			for tailPad := 0; tailPad < 4; tailPad++ {
				for limitDelta := 0; limitDelta < 4; limitDelta++ {
					s := strings.Repeat("x", headPad) + strings.Repeat(ch, 200) + strings.Repeat("y", tailPad)
					l := limit + limitDelta
					out := truncateMiddle(s, l)
					name := fmt.Sprintf("%q tête+%d queue+%d limite %d", ch, headPad, tailPad, l)
					if !utf8.ValidString(out) {
						t.Fatalf("%s : UTF-8 invalide %q", name, out)
					}
					if len(out) > l {
						t.Fatalf("%s : %d octets > %d", name, len(out), l)
					}
					head, tail, ok := strings.Cut(out, "\n[… sortie tronquée …]\n")
					if !ok || !strings.HasPrefix(s, head) || !strings.HasSuffix(s, tail) {
						t.Fatalf("%s : pas un début + marqueur + fin de l'original : %q", name, out)
					}
					// Au plus un caractère perdu de chaque côté par l'alignement.
					half := (l - len("\n[… sortie tronquée …]\n")) / 2
					if len(head) < half-3 || len(tail) < half-3 {
						t.Fatalf("%s : coupure trop large (tête %d, queue %d, moitié %d)", name, len(head), len(tail), half)
					}
				}
			}
		}
	}
}
