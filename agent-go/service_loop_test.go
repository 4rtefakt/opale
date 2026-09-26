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
	result := make(chan struct{})
	go func() {
		runServiceLoop(requests, work, func() { stopPendingAt <- time.Now() }, 5*time.Second)
		close(result)
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
	case <-result:
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
	result := make(chan struct{})
	go func() {
		runServiceLoop(requests, work, func() {}, time.Second)
		close(result)
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
	result := make(chan struct{})
	go func() {
		runServiceLoop(requests, work, func() {}, 100*time.Millisecond)
		close(result)
	}()
	<-started
	requests <- svcRequest{cmd: svcCmdStop}
	select {
	case <-result:
	case <-time.After(2 * time.Second):
		t.Fatal("arrêt non borné")
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
