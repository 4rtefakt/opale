package main

import (
	"context"
	"encoding/json"
	"fmt"
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
			MaintenanceWindow: s.window}
		for _, id := range s.pending[:n] {
			s.running[id] = true
			resp.Deployments = append(resp.Deployments, Deployment{
				DeploymentID: id, Name: id, Type: "script", InstallScript: "Write-Output " + id,
			})
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
	processDeploymentsFn = func(_ context.Context, deps []Deployment, sink resultSink) {
		for _, d := range deps {
			if f.beforeDeployment != nil {
				f.beforeDeployment(d.DeploymentID)
			}
			f.record("dep:" + d.DeploymentID)
			sink.deployment(DeploymentResult{DeploymentID: d.DeploymentID, ExitCode: 0, Output: "ok"})
			sink.detection(DetectionResult{PackageID: "pkg-" + d.DeploymentID, Detected: true})
		}
	}
	processDetectFn = func(context.Context, []Detect) []DetectionResult { return nil }
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
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	ts := httptest.NewServer(srv.handler(t))
	t.Cleanup(ts.Close)
	st := &State{LastTokenRotation: time.Now().UTC()}
	runCheckin(context.Background(), &Config{Token: "tok", URL: ts.URL}, st)
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
	var done []string
	var problems []string
	f.beforeDeployment = func(id string) {
		saved := LoadState()
		if got := depIDs(saved.PendingDeployments); !sameIDs(got, done) {
			problems = append(problems, fmt.Sprintf("avant %s : state.json = %v, attendu %v", id, got, done))
		}
		if len(saved.PendingDetections) != len(done) {
			problems = append(problems, fmt.Sprintf("avant %s : %d détections persistées, attendu %d", id, len(saved.PendingDetections), len(done)))
		}
		done = append(done, id)
	}
	st := runCheckinAgainst(t, srv)

	if len(problems) > 0 {
		t.Fatal(strings.Join(problems, "\n"))
	}
	assertEveryClaimedJobRanOnce(t, srv, f, st, 4)
}
