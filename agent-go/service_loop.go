package main

import (
	"context"
	"sync"
	"time"
)

// Boucle de contrôle du service, indépendante du SCM Windows (testable hors
// Windows). service_windows.go ne fait que traduire les requêtes SCM.
//
// Le travail de l'agent (checkins + WS) tourne dans une goroutine : un
// checkin peut durer plusieurs minutes (scripts, déploiements), et la
// boucle de contrôle doit malgré tout répondre tout de suite à Stop /
// Shutdown / Interrogate.

// serviceStopGrace — attente maximale de la fin du travail en cours après
// un Stop. Les checkins en cours reçoivent
// l'annulation (scripts tués via leur contexte) ; au-delà, on sort quand
// même.
const serviceStopGrace = 10 * time.Second

// svcCommand — requête du gestionnaire de services, déjà traduite.
type svcCommand int

const (
	svcCmdInterrogate svcCommand = iota
	svcCmdStop                   // Stop ou Shutdown
)

type svcRequest struct {
	cmd   svcCommand
	reply func() // Interrogate : renvoie l'état courant au SCM
}

// runServiceLoop lance work dans une goroutine et traite les requêtes du
// SCM sans jamais attendre un checkin :
//   - Interrogate : réponse immédiate ;
//   - Stop : onStopPending (StopPending au SCM), annulation du travail,
//     attente bornée par grace, puis retour ;
//   - fin inattendue du travail : retour.
func runServiceLoop(requests <-chan svcRequest, work func(ctx context.Context),
	onStopPending func(), grace time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		work(ctx)
	}()
	stop := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(grace):
			logWarn("service-stop-timeout", "travail en cours non terminé, arrêt forcé", LogFields{
				"grace_s": int(grace.Seconds()),
			})
		}
	}
	for {
		select {
		case req := <-requests:
			switch req.cmd {
			case svcCmdInterrogate:
				if req.reply != nil {
					req.reply()
				}
			case svcCmdStop:
				onStopPending()
				stop()
				return
			}
		case <-done:
			logWarn("service-worker-exit", "fin inattendue du travail de l'agent", nil)
			return
		}
	}
}

// runAgent — travail de l'agent : WS persistant + checkin immédiat puis
// toutes les `interval`. Retourne après annulation de ctx, une fois la
// goroutine WS terminée (qui ferme les consoles ouvertes).
func runAgent(ctx context.Context, interval time.Duration, checkin func(ctx context.Context), ws func(ctx context.Context)) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ws(ctx)
	}()
	defer wg.Wait()

	checkin(ctx)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			checkin(ctx)
		}
	}
}
