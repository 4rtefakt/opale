//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// restartService — détache un helper qui attend 5s puis fait `systemctl
// restart`. Comme sur Windows, on ne peut pas relancer le service depuis
// le service lui-même synchroniquement (systemctl bloquerait jusqu'à la
// fin de notre Stop, qu'on n'a pas encore initié). Le helper survit à
// notre exit grâce au double fork (Setsid).
//
// Si on n'est pas root (mode --debug interactif), no-op + log.
func restartService() error {
	if os.Geteuid() != 0 {
		logf("restartService : skip (non-root, mode interactif)")
		return nil
	}
	if !systemdAvailable() {
		logf("restartService : skip (systemd absent)")
		return nil
	}

	unitName := branding.ServiceName + ".service"
	cmd := exec.Command("/bin/sh", "-c", fmt.Sprintf("sleep 5 && systemctl restart %s", unitName))
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true, // détache du process group de l'agent
	}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn restart helper : %w", err)
	}
	logf("restart helper lancé (PID %d, restart dans 5s)", cmd.Process.Pid)
	_ = cmd.Process.Release()
	// Petit délai pour que le helper soit bien forké avant qu'on rende la main
	time.Sleep(100 * time.Millisecond)
	return nil
}

