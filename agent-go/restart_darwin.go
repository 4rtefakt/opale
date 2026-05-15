//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// restartService — détache un helper qui attend 5s puis fait `launchctl
// kickstart -k` sur notre service. Comme sur Linux, on ne peut pas se
// redémarrer synchroniquement depuis nous-même.
//
// Si on n'est pas root (mode --debug interactif), no-op + log.
func restartService() error {
	if os.Geteuid() != 0 {
		logf("restartService : skip (non-root, mode interactif)")
		return nil
	}
	target := "system/" + launchdLabel()
	cmd := exec.Command("/bin/sh", "-c",
		fmt.Sprintf("sleep 5 && launchctl kickstart -k %s", target))
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn restart helper : %w", err)
	}
	logf("restart helper lancé (PID %d, restart dans 5s)", cmd.Process.Pid)
	_ = cmd.Process.Release()
	time.Sleep(100 * time.Millisecond)
	return nil
}
