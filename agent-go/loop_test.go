package main

import (
	"bytes"
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
)

// jobServer — faux serveur qui réserve les travaux comme l'API : chaque
// checkin applique les résultats reçus (ligne 'running' → terminée), puis
// passe en 'running' jusqu'à batch déploiements en attente et les renvoie,
// avec les scripts prévus pour ce checkin et l'éventuelle mise à jour.
type jobServer struct {
	mu        sync.Mutex
	batch     int
	pending   []string
	running   map[string]bool
	results   map[string]int
	scriptsAt map[int][]Command // n° de checkin (à partir de 1) → scripts réservés
	update    *AgentUpdate
	window    *MaintenanceWindow
	checkins  int
	// noDetection — déploiements sans detection_script (les autres en ont un).
	noDetection map[string]bool
	// detectAt — détections périodiques demandées au n-ième checkin.
	detectAt map[int][]Detect
}

func newJobServer(nDeployments, batch int) *jobServer {
	s := &jobServer{batch: batch, running: map[string]bool{}, results: map[string]int{}, scriptsAt: map[int][]Command{}}
	for i := 1; i <= nDeployments; i++ {
		s.pending = append(s.pending, fmt.Sprintf("dep-%02d", i))
	}
	return s
}

func (s *jobServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/checkin" {
			http.NotFound(w, r)
			return
		}
		var p CheckinPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			t.Errorf("payload illisible : %v", err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.checkins++
		for _, res := range p.DeploymentResults {
			if s.running[res.DeploymentID] {
				delete(s.running, res.DeploymentID)
				s.results[res.DeploymentID]++
			}
		}
		n := min(s.batch, len(s.pending))
		resp := CheckinResponse{OK: true, DeviceID: "dev-1", Commands: s.scriptsAt[s.checkins], AgentUpdate: s.update,
			MaintenanceWindow: s.window, Detect: s.detectAt[s.checkins]}
		for _, id := range s.pending[:n] {
			s.running[id] = true
			d := Deployment{DeploymentID: id, PackageID: "pkg-" + id, Name: id, Type: "script", InstallScript: "Write-Output " + id}
			if !s.noDetection[id] {
				d.DetectionScript = "exit 0"
			}
			resp.Deployments = append(resp.Deployments, d)
		}
		s.pending = s.pending[n:]
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// fakeJobs remplace l'exécution réelle (PowerShell / winget, Windows) et
// l'auto-update, et trace l'ordre des actions.
type fakeJobs struct {
	mu    sync.Mutex
	order []string
	// beforeDeployment — appelé avant l'exécution de chaque déploiement.
	beforeDeployment func(id string)
}

func (f *fakeJobs) record(s string) {
	f.mu.Lock()
	f.order = append(f.order, s)
	f.mu.Unlock()
}

func (f *fakeJobs) count(prefix string) map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]int{}
	for _, s := range f.order {
		if strings.HasPrefix(s, prefix) {
			out[strings.TrimPrefix(s, prefix)]++
		}
	}
	return out
}

func installFakeJobs(t *testing.T) *fakeJobs {
	t.Helper()
	f := &fakeJobs{}
	origCmd, origDep, origDet, origUpd := processCommandsFn, processDeploymentsFn, processDetectFn, handleAgentUpdateFn
	origMetrics := collectMetricsFn
	t.Cleanup(func() {
		processCommandsFn, processDeploymentsFn, processDetectFn, handleAgentUpdateFn = origCmd, origDep, origDet, origUpd
		collectMetricsFn = origMetrics
		swappedVersion = ""
	})
	collectMetricsFn = func() (*CheckinPayload, error) { return &CheckinPayload{Hostname: "PC-TEST"}, nil }
	processCommandsFn = func(_ context.Context, _ *Config, cmds []Command) {
		for _, c := range cmds {
			f.record("cmd:" + c.ID)
		}
	}
	// Même boucle que processDeployments (eachDeployment) ; installation et
	// détection simulées comme runWithTimeout : contexte annulé → rien ne
	// démarre, installation en échec « interrompu », détection « absent ».
	processDeploymentsFn = func(ctx context.Context, deps []Deployment, sink resultSink) {
		eachDeployment(ctx, deps, func(d Deployment) {
			if f.beforeDeployment != nil {
				f.beforeDeployment(d.DeploymentID)
			}
			if ctx.Err() != nil {
				f.record("interrupted:" + d.DeploymentID)
				sink.deployment(deploymentResult(d, 1, "[interrompu : arrêt de l'agent]"))
			} else {
				f.record("dep:" + d.DeploymentID)
				sink.deployment(deploymentResult(d, 0, "ok"))
			}
			if det, ok := postInstallDetection(ctx, d, func(ctx context.Context, _ string) (int, string) {
				if ctx.Err() != nil {
					return 1, "[interrompu : arrêt de l'agent]"
				}
				return 0, ""
			}); ok {
				sink.detection(det)
			}
		})
	}
	processDetectFn = func(ctx context.Context, dets []Detect) []DetectionResult {
		var out []DetectionResult
		for _, d := range dets {
			f.record("detect:" + d.PackageID)
			out = append(out, DetectionResult{PackageID: d.PackageID, Detected: ctx.Err() == nil})
		}
		return out
	}
	// Mise à jour réussie : binaire permuté, redémarrage en attente.
	handleAgentUpdateFn = func(_ context.Context, _ *Config, _ *State, upd *AgentUpdate) error {
		f.record("update:" + upd.LatestVersion)
		swappedVersion = upd.LatestVersion
		return nil
	}
	return f
}

func runCheckinAgainst(t *testing.T, srv *jobServer) *State {
	t.Helper()
	return runCheckinAgainstCtx(t, context.Background(), srv)
}

func runCheckinAgainstCtx(t *testing.T, ctx context.Context, srv *jobServer) *State {
	t.Helper()
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	ts := httptest.NewServer(srv.handler(t))
	t.Cleanup(ts.Close)
	st := &State{LastTokenRotation: time.Now().UTC()}
	runCheckin(ctx, &Config{Token: "tok", URL: ts.URL}, st)
	return st
}

// assertEveryClaimedJobRanOnce — chaque déploiement réservé ('running') par
// le serveur a été exécuté exactement une fois, et son résultat reçu une
// fois sauf s'il est encore en file côté agent.
func assertEveryClaimedJobRanOnce(t *testing.T, srv *jobServer, f *fakeJobs, st *State, wantRun int) {
	t.Helper()
	ran := f.count("dep:")
	if len(ran) != wantRun {
		t.Fatalf("%d déploiements exécutés, attendu %d (%v)", len(ran), wantRun, ran)
	}
	for id, n := range ran {
		if n != 1 {
			t.Fatalf("%s exécuté %d fois", id, n)
		}
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	queued := map[string]bool{}
	for _, r := range st.PendingDeployments {
		queued[r.DeploymentID] = true
	}
	for id := range srv.running {
		if ran[id] == 0 {
			t.Fatalf("%s réservé par le serveur mais jamais exécuté (perdu jusqu'au timeout)", id)
		}
		if !queued[id] {
			t.Fatalf("%s exécuté, sans résultat reçu ni en file", id)
		}
	}
	for id, n := range srv.results {
		if n != 1 || ran[id] != 1 {
			t.Fatalf("%s : %d résultat(s) reçu(s), exécuté %d fois", id, n, ran[id])
		}
	}
}

// Plus d'un lot : 11 déploiements, lots de 10. Le re-checkin qui remonte
// les 10 premiers résultats réserve le 11e : il doit être exécuté (avant :
// réponse ignorée, déploiement 'running' jusqu'au timeout sans avoir tourné).
// Idem pour un script réservé par ce re-checkin.
func TestRunCheckin_FollowUpCheckinJobsExecuted(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(11, 10)
	srv.scriptsAt[2] = []Command{{ID: "cmd-follow-up", Name: "diag", Script: "hostname"}}
	st := runCheckinAgainst(t, srv)

	assertEveryClaimedJobRanOnce(t, srv, f, st, 11)
	if len(srv.results) != 11 || len(st.PendingDeployments) != 0 {
		t.Fatalf("résultats reçus %d / 11, restés en file %d", len(srv.results), len(st.PendingDeployments))
	}
	if f.count("cmd:")["cmd-follow-up"] != 1 {
		t.Fatalf("script réservé par le re-checkin non exécuté : %v", f.order)
	}
}

// Une réponse qui propose une mise à jour ET porte des travaux déjà
// réservés : les travaux passent d'abord, la mise à jour ensuite (avant :
// retour dès le binaire permuté, travaux perdus).
func TestRunCheckin_UpdateResponseJobsExecutedBeforeUpdate(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(12, 10)
	srv.update = &AgentUpdate{LatestVersion: "9.9.9", SHA256: "00", Signature: "AA=="}
	srv.scriptsAt[1] = []Command{{ID: "cmd-1", Name: "diag", Script: "hostname"}}
	st := runCheckinAgainst(t, srv)

	assertEveryClaimedJobRanOnce(t, srv, f, st, 12)
	if len(srv.results) != 12 {
		t.Fatalf("résultats reçus %d / 12", len(srv.results))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.order) != 14 || f.order[0] != "cmd:cmd-1" || f.order[len(f.order)-1] != "update:9.9.9" {
		t.Fatalf("ordre attendu : script, 12 déploiements, puis une seule mise à jour ; reçu %v", f.order)
	}
}

// Enchaînement borné : au-delà de maxFollowUpCheckins, plus de re-checkin
// (donc plus de réservation) dans ce cycle — tout ce qui a été réservé a
// été exécuté, les derniers résultats partent au cycle suivant.
func TestRunCheckin_FollowUpsBoundedWithoutLosingClaimedJobs(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(10*(maxFollowUpCheckins+3), 10)
	st := runCheckinAgainst(t, srv)

	assertEveryClaimedJobRanOnce(t, srv, f, st, 10*(maxFollowUpCheckins+1))
	if len(st.PendingDeployments) != 10 {
		t.Fatalf("dernier lot : %d résultats en file, attendu 10", len(st.PendingDeployments))
	}
	if saved := LoadState(); len(saved.PendingDeployments) != 10 {
		t.Fatalf("dernier lot non persisté : %d résultats dans state.json", len(saved.PendingDeployments))
	}
}

// La fenêtre de maintenance des déploiements est appliquée par le serveur,
// qui ne les réserve qu'en fenêtre. L'agent ne la réévalue plus : un avis
// divergent (fuseau invalide, « 2:5 », dérive d'horloge en bord de fenêtre)
// laissait des déploiements déjà 'running' sans exécution, puis en échec
// au timeout, à chaque cycle.
func TestRunCheckin_DeploymentsRunEvenIfAgentThinksOutOfWindow(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(3, 10)
	// Fenêtre fermée aujourd'hui du point de vue de l'agent (tous les jours
	// sauf aujourd'hui, UTC) : le serveur, lui, l'a jugée ouverte.
	today := int(time.Now().UTC().Weekday())
	var otherDays []int
	for d := 0; d < 7; d++ {
		if d != today {
			otherDays = append(otherDays, d)
		}
	}
	srv.window = &MaintenanceWindow{Weekdays: otherDays, Start: "00:00", End: "23:59", TZ: "UTC"}
	st := runCheckinAgainst(t, srv)

	assertEveryClaimedJobRanOnce(t, srv, f, st, 3)
	if len(srv.results) != 3 {
		t.Fatalf("résultats reçus %d / 3", len(srv.results))
	}
}

// Chaque résultat est persisté dès que son déploiement se termine : au
// démarrage du déploiement n, state.json contient déjà les résultats (et
// détections post-install) des n-1 précédents du lot. Avant, rien n'était
// écrit avant la fin du lot : un crash, une coupure ou un installeur qui
// tue l'agent perdait les résultats des déploiements déjà terminés.
func TestRunCheckin_EachDeploymentResultPersistedImmediately(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(4, 10)
	// dep-02 sans detection_script : son résultat n'est suivi d'aucune
	// détection, dont la sauvegarde persisterait aussi le résultat.
	srv.noDetection = map[string]bool{"dep-02": true}
	var done []string
	detections := 0
	var problems []string
	f.beforeDeployment = func(id string) {
		saved := LoadState()
		if got := depIDs(saved.PendingDeployments); !sameIDs(got, done) {
			problems = append(problems, fmt.Sprintf("avant %s : state.json = %v, attendu %v", id, got, done))
		}
		if len(saved.PendingDetections) != detections {
			problems = append(problems, fmt.Sprintf("avant %s : %d détections persistées, attendu %d", id, len(saved.PendingDetections), detections))
		}
		done = append(done, id)
		if !srv.noDetection[id] {
			detections++
		}
	}
	st := runCheckinAgainst(t, srv)

	if len(problems) > 0 {
		t.Fatal(strings.Join(problems, "\n"))
	}
	assertEveryClaimedJobRanOnce(t, srv, f, st, 4)
}

// cancelAfterCheckin — transport qui annule le contexte de l'agent juste
// après la n-ième réponse de checkin, corps déjà lu : réponse reçue
// intacte, arrêt (Stop du service) avant son traitement.
type cancelAfterCheckin struct {
	base   http.RoundTripper
	at     int
	cancel context.CancelFunc
	mu     sync.Mutex
	n      int
}

func (c *cancelAfterCheckin) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := c.base.RoundTrip(r)
	if err != nil || r.URL.Path != "/api/agent/checkin" {
		return resp, err
	}
	c.mu.Lock()
	c.n++
	hit := c.n == c.at
	c.mu.Unlock()
	if hit {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(body))
		c.cancel()
	}
	return resp, nil
}

// Arrêt de l'agent pendant le re-checkin : les travaux de sa réponse ne
// sont pas lancés (contexte annulé : ils seraient remontés en échec
// « interrompu » sans avoir tourné) ; réservés côté serveur, ils relèvent
// du timeout comme avant. Et plus de re-checkin après l'arrêt (rien de
// nouveau réservé).
func TestRunCheckin_StopDuringFollowUpLeavesItsJobsUnstarted(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(21, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	origClient := httpClient
	httpClient = &http.Client{Timeout: 30 * time.Second,
		Transport: &cancelAfterCheckin{base: http.DefaultTransport, at: 2, cancel: cancel}}
	t.Cleanup(func() { httpClient = origClient })

	st := runCheckinAgainstCtx(t, ctx, srv)

	if n := len(f.count("interrupted:")); n != 0 {
		t.Fatalf("%d déploiement(s) du re-checkin remonté(s) en échec sans avoir tourné : %v", n, f.order)
	}
	if n := len(f.count("dep:")); n != 10 {
		t.Fatalf("%d déploiements exécutés, attendu les 10 du premier lot", n)
	}
	for _, r := range st.PendingDeployments {
		if r.ExitCode != 0 {
			t.Fatalf("résultat d'échec en file pour un déploiement non lancé : %+v", r)
		}
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.checkins != 2 || len(srv.running) != 10 || len(srv.pending) != 1 {
		t.Fatalf("checkins=%d running=%d pending=%d, attendu 2 / 10 (2e lot, timeout) / 1 (jamais réservé)",
			srv.checkins, len(srv.running), len(srv.pending))
	}
}

// Arrêt de l'agent pendant le 2e déploiement d'un lot de 5 : les 3 suivants
// ne démarrent pas (réservés, ils relèvent du timeout) au lieu d'être
// remontés en échec « interrompu » ; toute détection produite après
// l'arrêt (post-install du 2e, détections périodiques) est écartée — elle
// dirait « absent » et écrirait un inventaire faux pour 24 h.
func TestRunCheckin_StopMidBatchReportsNoFalseResults(t *testing.T) {
	f := installFakeJobs(t)
	srv := newJobServer(5, 10)
	srv.detectAt = map[int][]Detect{1: {{PackageID: "pkg-periodique", DetectionScript: "exit 0"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.beforeDeployment = func(id string) {
		if id == "dep-02" {
			cancel() // Stop du service pendant l'installation de dep-02
		}
	}
	st := runCheckinAgainstCtx(t, ctx, srv)

	// dep-01 terminé ; dep-02 démarré puis interrompu (résultat légitime).
	if got := depIDs(st.PendingDeployments); !sameIDs(got, []string{"dep-01", "dep-02"}) {
		t.Fatalf("résultats en file %v, attendu [dep-01 dep-02] (dep-03..05 jamais démarrés)", got)
	}
	for _, id := range []string{"dep-03", "dep-04", "dep-05"} {
		if n := f.count("interrupted:")[id] + f.count("dep:")[id]; n != 0 {
			t.Fatalf("%s lancé après l'arrêt : %v", id, f.order)
		}
	}
	for _, d := range st.PendingDetections {
		if !d.Detected || d.PackageID != "pkg-dep-01" {
			t.Fatalf("détection produite après l'arrêt mise en file : %+v (toutes : %+v)", d, st.PendingDetections)
		}
	}
	if len(st.PendingDetections) != 1 {
		t.Fatalf("détections en file %+v, attendu seulement pkg-dep-01", st.PendingDetections)
	}
	if n := len(f.count("detect:")); n != 0 {
		t.Fatalf("détections périodiques lancées après l'arrêt : %v", f.order)
	}
	if saved := LoadState(); !sameIDs(depIDs(saved.PendingDeployments), []string{"dep-01", "dep-02"}) || len(saved.PendingDetections) != 1 {
		t.Fatalf("state.json : %+v / %+v", saved.PendingDeployments, saved.PendingDetections)
	}
}
