//go:build windows

package main

import (
	"fmt"
	"os/exec"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// platformSelfTests — tests spécifiques Windows : présence du service,
// powershell.exe accessible. Ces tests sont skippés sur autres OS.
func platformSelfTests() []func() testResult {
	return []func() testResult{
		testPowerShellAvailable,
		testServiceInstalled,
	}
}

func testPowerShellAvailable() testResult {
	p, err := exec.LookPath("powershell.exe")
	if err != nil {
		return testResult{Name: "PowerShell disponible", Message: err.Error()}
	}
	return testResult{Name: "PowerShell disponible", OK: true, Message: p}
}

func testServiceInstalled() testResult {
	m, err := mgr.Connect()
	if err != nil {
		return testResult{Name: "Windows Service installé",
			Message: fmt.Sprintf("SCM : %v", err)}
	}
	defer m.Disconnect()
	s, err := m.OpenService(branding.ServiceName)
	if err != nil {
		return testResult{Name: "Windows Service installé",
			Message: fmt.Sprintf("%s : %v", branding.ServiceName, err)}
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return testResult{Name: "Windows Service installé",
			Message: fmt.Sprintf("query : %v", err)}
	}
	state := svcStateName(status.State)
	cfg, err := s.Config()
	startMode := "?"
	if err == nil {
		switch cfg.StartType {
		case mgr.StartAutomatic:
			startMode = "automatic"
		case mgr.StartManual:
			startMode = "manual"
		case mgr.StartDisabled:
			startMode = "disabled"
		}
	}
	return testResult{Name: "Windows Service installé", OK: true,
		Message: fmt.Sprintf("%s — state=%s start=%s", branding.ServiceName, state, startMode)}
}

func svcStateName(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start-pending"
	case svc.StopPending:
		return "stop-pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue-pending"
	case svc.PausePending:
		return "pause-pending"
	case svc.Paused:
		return "paused"
	}
	return fmt.Sprintf("0x%x", int(s))
}
