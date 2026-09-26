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
// un Stop ou avant un redémarrage. Les checkins en cours reçoivent
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

// serviceExit — raison de sortie de runServiceLoop.
type serviceExit int

const (
	serviceExitStopped serviceExit = iota // arrêt demandé par le SCM
	serviceExitRestart                    // redémarrage demandé (update / rollback)
)

// restartRequests — l'auto-update et le rollback (Windows) demandent le
// redémarrage du service une fois le binaire permuté (cf. restart_windows.go).
var restartRequests = make(chan struct{}, 1)

func requestServiceRestart() {
	select {
	case restartRequests <- struct{}{}:
	default: // déjà demandé
	}
}

// runServiceLoop lance work dans une goroutine et traite les requêtes du
// SCM sans jamais attendre un checkin :
//   - Interrogate : réponse immédiate ;
//   - Stop : onStopPending (StopPending au SCM), annulation du travail,
//     attente bornée par grace, retour serviceExitStopped ;
//   - redémarrage demandé : si canRestart() confirme que le SCM relancera
//     le service, annulation + attente bornée puis serviceExitRestart ;
//     sinon la demande est ignorée (le nouveau binaire démarrera au
//     prochain boot, comme avant) ;
//   - fin inattendue du travail : serviceExitRestart.
func runServiceLoop(requests <-chan svcRequest, restart <-chan struct{}, work func(ctx context.Context),
	onStopPending func(), canRestart func() bool, grace time.Duration) serviceExit {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		work(ctx)
	}()
	// stop annule le travail et attend sa fin (bornée par grace) en
	// continuant à servir le SCM : Interrogate reçoit sa réponse, et un Stop
	// reçu pendant l'attente d'un redémarrage l'emporte (sinon le SCM
	// relancerait un service que l'admin vient d'arrêter).
	stop := func(exit serviceExit) serviceExit {
		cancel()
		timer := time.NewTimer(grace)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return exit
			case <-timer.C:
				logWarn("service-stop-timeout", "travail en cours non terminé, arrêt forcé", LogFields{
					"grace_s": int(grace.Seconds()),
				})
				return exit
			case req := <-requests:
				switch req.cmd {
				case svcCmdInterrogate:
					if req.reply != nil {
						req.reply()
					}
				case svcCmdStop:
					if exit != serviceExitStopped {
						onStopPending()
						exit = serviceExitStopped
					}
				}
			}
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
				return stop(serviceExitStopped)
			}
		case <-restart:
			if !canRestart() {
				logError("service-restart-unavailable", nil, LogFields{
					"hint": "actions de récupération du service absentes : nouveau binaire actif au prochain redémarrage du poste",
				})
				continue
			}
			return stop(serviceExitRestart)
		case <-done:
			logWarn("service-worker-exit", "fin inattendue du travail de l'agent", nil)
			return serviceExitRestart
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

// svcRecoveryAction — action de récupération SCM, vue neutre.
type svcRecoveryAction struct {
	Restart bool
	Delay   time.Duration
}

// Actions de récupération posées par les installeurs (sc.exe failure …
// reset= 86400 actions= restart/5000/restart/5000/restart/30000) et
// réappliquées par l'agent au démarrage du service.
var wantedRecoveryActions = []svcRecoveryAction{
	{Restart: true, Delay: 5 * time.Second},
	{Restart: true, Delay: 5 * time.Second},
	{Restart: true, Delay: 30 * time.Second},
}

const wantedRecoveryResetSeconds = 86400

// recoveryRestartsAlways — true si le SCM relancera le service quel que
// soit le nombre d'échecs récents : au moins une action, toutes « restart »
// (la dernière est répétée au-delà), avec un délai raisonnable.
func recoveryRestartsAlways(actions []svcRecoveryAction) bool {
	if len(actions) == 0 {
		return false
	}
	for _, a := range actions {
		if !a.Restart || a.Delay > 5*time.Minute {
			return false
		}
	}
	return true
}
