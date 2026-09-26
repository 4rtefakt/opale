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

	runServiceLoop(requests, work, onStopPending, serviceStopGrace)
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
