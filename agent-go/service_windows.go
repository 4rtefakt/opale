//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// serviceRestartExitCode — code de sortie quand l'agent quitte pour être
// relancé par le SCM (après permutation du binaire). Toute sortie du
// process sans avoir signalé SERVICE_STOPPED est un « échec » pour le SCM,
// qui applique alors les actions de récupération (restart).
const serviceRestartExitCode = 1

// agentService implémente svc.Handler.
type agentService struct{}

func (s *agentService) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}

	cfg, err := LoadConfig()
	if err != nil {
		logf("config invalide : %v", err)
		status <- svc.Status{State: svc.Stopped}
		return false, 1
	}

	st := LoadState()
	CheckBinaryIntegrity(st)

	// Les installs existantes récupèrent ainsi les actions de récupération
	// dont dépend le redémarrage après auto-update.
	if err := ensureServiceRecoveryActions(); err != nil {
		logError("service-recovery-actions", err, nil)
	}

	status <- svc.Status{State: svc.Running, Accepts: accepted}
	logInfo("service-start", "", LogFields{"interval": CheckinInterval.String()})

	// Traduction des requêtes SCM → requêtes neutres. S'arrête avec la boucle.
	requests := make(chan svcRequest)
	loopDone := make(chan struct{})
	defer close(loopDone)
	go func() {
		for {
			select {
			case c := <-r:
				var req svcRequest
				switch c.Cmd {
				case svc.Interrogate:
					cur := c.CurrentStatus
					req = svcRequest{cmd: svcCmdInterrogate, reply: func() { status <- cur }}
				case svc.Stop, svc.Shutdown:
					req = svcRequest{cmd: svcCmdStop}
				default:
					logf("svc cmd inattendue : %v", c.Cmd)
					continue
				}
				select {
				case requests <- req:
				case <-loopDone:
					return
				}
			case <-loopDone:
				return
			}
		}
	}()

	// WS persistant + checkins, dans une goroutine : la boucle de contrôle
	// reste disponible pendant un checkin long.
	work := func(ctx context.Context) {
		runAgent(ctx, CheckinInterval,
			func(ctx context.Context) { runCheckin(ctx, cfg, st) },
			func(ctx context.Context) { RunWSClient(ctx, cfg) })
	}
	onStopPending := func() {
		logInfo("service-stop", "demandé par SCM", nil)
		status <- svc.Status{State: svc.StopPending, WaitHint: uint32((serviceStopGrace + 5*time.Second) / time.Millisecond)}
	}
	canRestart := func() bool {
		if err := ensureServiceRecoveryActions(); err != nil {
			logError("service-recovery-actions", err, nil)
			return false
		}
		return true
	}

	switch runServiceLoop(requests, restartRequests, work, onStopPending, canRestart, serviceStopGrace) {
	case serviceExitRestart:
		// Sortie SANS signaler SERVICE_STOPPED : le SCM la traite comme un
		// échec et relance le service (nouveau binaire) après le délai des
		// actions de récupération. Remplace l'ancien helper
		// « cmd /c timeout … && sc stop && sc start » : timeout.exe refuse
		// une entrée redirigée (stdin = NUL), la chaîne s'arrêtait là et le
		// service n'était jamais relancé.
		logInfo("service-exit-for-restart", "sortie pour relance par le SCM", LogFields{
			"exit_code": serviceRestartExitCode,
		})
		closeLog()
		os.Exit(serviceRestartExitCode)
	}
	return false, 0
}

// RunService — appelé par main quand on est lancé par le SCM.
func RunService() error {
	return svc.Run(branding.ServiceName, &agentService{})
}

// IsWindowsService — true si on est lancé par le SCM (vs en interactif).
func IsWindowsService() (bool, error) {
	return svc.IsWindowsService()
}

// servicePanic — surface formatée pour main.
func servicePanic(err error) error {
	return fmt.Errorf("Run service : %w", err)
}
