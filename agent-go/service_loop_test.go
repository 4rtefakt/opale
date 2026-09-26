package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// Un checkin long (script, déploiement) ne doit pas empêcher la boucle de
// service de répondre à Stop : StopPending est envoyé immédiatement et le
// checkin reçoit l'annulation.
func TestRunServiceLoop_StopAnsweredDuringLongCheckin(t *testing.T) {
	requests := make(chan svcRequest)
	checkinStarted := make(chan struct{})
	var checkinCanceled atomic.Bool
	work := func(ctx context.Context) {
		runAgent(ctx, time.Hour, func(ctx context.Context) {
			close(checkinStarted)
			<-ctx.Done() // script en cours, tué par l'annulation
			checkinCanceled.Store(true)
		}, func(ctx context.Context) { <-ctx.Done() })
	}
	stopPendingAt := make(chan time.Time, 1)
	result := make(chan serviceExit, 1)
	go func() {
		result <- runServiceLoop(requests, make(chan struct{}), work,
			func() { stopPendingAt <- time.Now() }, func() bool { return true }, 5*time.Second)
	}()

	<-checkinStarted
	sent := time.Now()
	select {
	case requests <- svcRequest{cmd: svcCmdStop}:
	case <-time.After(time.Second):
		t.Fatal("la boucle de service n'accepte pas Stop pendant un checkin")
	}
	select {
	case at := <-stopPendingAt:
		if d := at.Sub(sent); d > 500*time.Millisecond {
			t.Fatalf("StopPending après %v", d)
		}
	case <-time.After(time.Second):
		t.Fatal("StopPending jamais envoyé")
	}
	select {
	case r := <-result:
		if r != serviceExitStopped {
			t.Fatalf("sortie %v, attendu serviceExitStopped", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("la boucle ne s'est pas arrêtée")
	}
	if !checkinCanceled.Load() {
		t.Fatal("le checkin en cours n'a pas reçu l'annulation")
	}
}

func TestRunServiceLoop_InterrogateDuringCheckin(t *testing.T) {
	requests := make(chan svcRequest)
	busy := make(chan struct{})
	work := func(ctx context.Context) {
		close(busy)
		<-ctx.Done()
	}
	result := make(chan serviceExit, 1)
	go func() {
		result <- runServiceLoop(requests, make(chan struct{}), work, func() {}, func() bool { return true }, time.Second)
	}()
	<-busy
	replied := make(chan struct{})
	select {
	case requests <- svcRequest{cmd: svcCmdInterrogate, reply: func() { close(replied) }}:
	case <-time.After(time.Second):
		t.Fatal("Interrogate non accepté")
	}
	select {
	case <-replied:
	case <-time.After(time.Second):
		t.Fatal("Interrogate sans réponse")
	}
	requests <- svcRequest{cmd: svcCmdStop}
	<-result
}

// Travail qui ignore l'annulation : l'arrêt reste borné par grace.
func TestRunServiceLoop_StopBoundedWhenWorkHangs(t *testing.T) {
	requests := make(chan svcRequest)
	started := make(chan struct{})
	block := make(chan struct{})
	defer close(block)
	work := func(ctx context.Context) {
		close(started)
		<-block
	}
	result := make(chan serviceExit, 1)
	go func() {
		result <- runServiceLoop(requests, make(chan struct{}), work, func() {}, func() bool { return true }, 100*time.Millisecond)
	}()
	<-started
	requests <- svcRequest{cmd: svcCmdStop}
	select {
	case <-result:
	case <-time.After(2 * time.Second):
		t.Fatal("arrêt non borné")
	}
}

// Redémarrage demandé : n'a lieu que si le SCM relancera le service.
func TestRunServiceLoop_RestartOnlyWithRecoveryActions(t *testing.T) {
	for _, can := range []bool{false, true} {
		requests := make(chan svcRequest)
		restart := make(chan struct{}, 1)
		var canCalls atomic.Int32
		work := func(ctx context.Context) { <-ctx.Done() }
		result := make(chan serviceExit, 1)
		go func() {
			result <- runServiceLoop(requests, restart, work, func() {},
				func() bool { canCalls.Add(1); return can }, time.Second)
		}()
		restart <- struct{}{}
		if can {
			select {
			case r := <-result:
				if r != serviceExitRestart {
					t.Fatalf("sortie %v, attendu serviceExitRestart", r)
				}
			case <-time.After(time.Second):
				t.Fatal("redémarrage non effectué")
			}
			continue
		}
		// Sans actions de récupération : la demande est ignorée, le service continue.
		deadline := time.Now().Add(time.Second)
		for canCalls.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		select {
		case r := <-result:
			t.Fatalf("sortie %v alors que le SCM ne relancerait pas le service", r)
		case <-time.After(100 * time.Millisecond):
		}
		requests <- svcRequest{cmd: svcCmdStop}
		if r := <-result; r != serviceExitStopped {
			t.Fatalf("sortie %v après Stop", r)
		}
	}
}

func TestRunAgent_WaitsForWSOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var wsDone atomic.Bool
	checkins := make(chan struct{}, 1)
	returned := make(chan struct{})
	go func() {
		runAgent(ctx, time.Hour, func(context.Context) { checkins <- struct{}{} }, func(ctx context.Context) {
			<-ctx.Done()
			time.Sleep(20 * time.Millisecond) // fermeture des consoles
			wsDone.Store(true)
		})
		close(returned)
	}()
	<-checkins // checkin immédiat au démarrage
	cancel()
	<-returned
	if !wsDone.Load() {
		t.Fatal("runAgent a rendu la main avant la fin de la goroutine WS")
	}
}

func TestRecoveryRestartsAlways(t *testing.T) {
	r := func(d time.Duration) svcRecoveryAction { return svcRecoveryAction{Restart: true, Delay: d} }
	cases := []struct {
		name string
		in   []svcRecoveryAction
		want bool
	}{
		{"aucune action", nil, false},
		{"installeurs", wantedRecoveryActions, true},
		{"restart puis rien", []svcRecoveryAction{r(5 * time.Second), {}}, false},
		{"restart unique (répété)", []svcRecoveryAction{r(time.Minute)}, true},
		{"délai excessif", []svcRecoveryAction{r(time.Hour)}, false},
	}
	for _, c := range cases {
		if got := recoveryRestartsAlways(c.in); got != c.want {
			t.Errorf("%s : %v, attendu %v", c.name, got, c.want)
		}
	}
}

// Après une permutation réussie, ne pas re-télécharger à chaque checkin
// tant que le redémarrage n'a pas eu lieu, mais le redemander.
func TestHandleAgentUpdate_SkipsWhileRestartPending(t *testing.T) {
	swappedVersion = "9.9.9"
	var restarts atomic.Int32
	origRestart := restartServiceFn
	restartServiceFn = func() error { restarts.Add(1); return nil }
	defer func() { swappedVersion = ""; restartServiceFn = origRestart }()
	cfg := &Config{Token: "t", URL: "http://127.0.0.1:1"} // injoignable : tout téléchargement échouerait
	err := HandleAgentUpdate(context.Background(), cfg, &State{}, &AgentUpdate{
		LatestVersion: "9.9.9", SHA256: "00", Signature: "AA==",
	})
	if err != nil {
		t.Fatalf("attendu nil (redémarrage en attente), reçu %v", err)
	}
	if restarts.Load() != 1 {
		t.Fatalf("redémarrage redemandé %d fois, attendu 1", restarts.Load())
	}
}

// L'ancienne image qui tourne encore (redémarrage en attente) ne doit ni
// valider l'update (le nouveau binaire perdrait sa surveillance rollback)
// ni déclencher un rollback sur ses propres échecs.
func TestCheckRollback_IgnoredWhileRestartPending(t *testing.T) {
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	swappedVersion = "9.9.9"
	var restarts atomic.Int32
	origRestart := restartServiceFn
	restartServiceFn = func() error { restarts.Add(1); return nil }
	defer func() { swappedVersion = ""; restartServiceFn = origRestart }()

	updatedAt := time.Now().UTC().Add(-time.Minute)
	st := &State{LastUpdateAt: updatedAt, LastUpdateVersion: "9.9.9"}
	CheckRollback(st, nil)
	if !st.LastUpdateAt.Equal(updatedAt) || st.LastUpdateVersion != "9.9.9" {
		t.Fatalf("surveillance du nouveau binaire retirée par l'ancienne image : %+v", st)
	}
	for i := 0; i < MaxFailedSinceUpdate+1; i++ {
		CheckRollback(st, context.DeadlineExceeded)
	}
	if st.FailedSinceUpdate != 0 || restarts.Load() != 0 {
		t.Fatalf("échecs de l'ancienne image comptés contre le nouveau binaire : failed=%d restarts=%d", st.FailedSinceUpdate, restarts.Load())
	}
}
