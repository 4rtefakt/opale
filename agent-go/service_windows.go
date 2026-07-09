//go:build windows

package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/4rtefakt/opale/agent-go/branding"
)

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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	status <- svc.Status{State: svc.Running, Accepts: accepted}
	logInfo("service-start", "", LogFields{"interval": CheckinInterval.String()})

	// WS persistant en parallèle du polling. Cycle de vie attaché au même
	// ctx que le service : le SCM Stop annule les deux ensemble.
	go RunWSClient(ctx, cfg)

	// Premier checkin en goroutine (via launchCheckin) : un hang au tout
	// premier cycle ne doit pas empêcher le SCM de voir l'état Running ni
	// de traiter un Stop.
	launchCheckin(ctx, cfg, st)

	tick := time.NewTicker(CheckinInterval)
	defer tick.Stop()

	// Watchdog : si aucun checkin n'aboutit (revient) pendant watchdogStall,
	// on considère l'agent gelé (typiquement un appel WMI non annulable) et
	// on redémarre le service. C'est le filet de sécurité qui manquait lors
	// de l'incident 07/2026 où tout le parc est resté figé plusieurs jours.
	const watchdogStall = 3 * CheckinInterval // 45 min
	wd := time.NewTicker(time.Minute)
	defer wd.Stop()

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				logInfo("service-stop", "demandé par SCM", nil)
				status <- svc.Status{State: svc.StopPending}
				cancel()
				return false, 0
			default:
				logf("svc cmd inattendue : %v", c.Cmd)
			}
		case <-tick.C:
			launchCheckin(ctx, cfg, st)
		case <-wd.C:
			if checkinStalled(watchdogStall) {
				logError("watchdog-restart", fmt.Errorf("aucun checkin abouti depuis %s — redémarrage", watchdogStall), nil)
				status <- svc.Status{State: svc.StopPending}
				_ = restartService()
				cancel()
				return false, 0
			}
		}
	}
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
