//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"syscall"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// restartService — redémarre le service via un helper détaché en
// background. Sans ce helper, sc stop/start depuis le service lui-même
// le tuerait avant de pouvoir redémarrer. La séquence "timeout 5 ; stop ;
// start" laisse le temps au service de remonter son état Stop au SCM.
//
// La fonction retourne dans tous les cas — c'est au caller de quitter
// le service proprement (sortir de la boucle Run) après l'appel.
func restartService() error {
	// Retry sur le start : un échec transitoire (fichier encore verrouillé,
	// SCM occupé) laissait sinon le service proprement ARRÊTÉ — et les
	// recovery actions SCM ne se déclenchent que sur crash, pas sur stop
	// propre. Deux tentatives espacées de 10s couvrent ces cas.
	svc := branding.ServiceName
	args := []string{
		"/c",
		"timeout /t 5 /nobreak >nul && sc stop " + svc +
			" && timeout /t 3 /nobreak >nul && (sc start " + svc +
			" || (timeout /t 10 /nobreak >nul & sc start " + svc + "))",
	}
	cmd := exec.Command("cmd.exe", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn restart helper : %w", err)
	}
	logf("restart helper lancé (PID %d)", cmd.Process.Pid)
	// Détacher : on ne wait pas, le helper survivra à la sortie du service
	_ = cmd.Process.Release()
	return nil
}
