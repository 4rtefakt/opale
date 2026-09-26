//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows/svc/mgr"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// ensureServiceRecoveryActions vérifie que le SCM relancera le service
// après un échec (cf. recoveryRestartsAlways) et, sinon, pose les mêmes
// actions que les installeurs (restart 5 s / 5 s / 30 s, reset 24 h).
// Retourne nil seulement si la configuration relue est satisfaisante.
func ensureServiceRecoveryActions() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("SCM : %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(branding.ServiceName)
	if err != nil {
		return fmt.Errorf("service %s : %w", branding.ServiceName, err)
	}
	defer s.Close()

	current, err := s.RecoveryActions()
	if err != nil {
		return fmt.Errorf("lecture actions de récupération : %w", err)
	}
	if recoveryRestartsAlways(fromMgrActions(current)) {
		return nil
	}
	want := make([]mgr.RecoveryAction, 0, len(wantedRecoveryActions))
	for _, a := range wantedRecoveryActions {
		want = append(want, mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: a.Delay})
	}
	if err := s.SetRecoveryActions(want, wantedRecoveryResetSeconds); err != nil {
		return fmt.Errorf("pose actions de récupération : %w", err)
	}
	after, err := s.RecoveryActions()
	if err != nil {
		return fmt.Errorf("relecture actions de récupération : %w", err)
	}
	if !recoveryRestartsAlways(fromMgrActions(after)) {
		return fmt.Errorf("actions de récupération toujours incomplètes après écriture")
	}
	logInfo("service-recovery-actions-set", "actions de récupération (re)posées", nil)
	return nil
}

func fromMgrActions(in []mgr.RecoveryAction) []svcRecoveryAction {
	out := make([]svcRecoveryAction, 0, len(in))
	for _, a := range in {
		out = append(out, svcRecoveryAction{Restart: a.Type == mgr.ServiceRestart, Delay: a.Delay})
	}
	return out
}
