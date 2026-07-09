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
// le tuerait avant de pouvoir redémarrer. Le délai laisse le temps au
// service de remonter son état Stop au SCM avant le stop/start.
//
// IMPORTANT : on utilise PowerShell Start-Sleep, PAS `timeout /t`. `timeout`
// exige un handle console d'entrée ; lancé en DETACHED_PROCESS (sans console)
// il échoue immédiatement — et avec l'ancien `&&`, l'échec court-circuitait
// stop/start, donc le service NE redémarrait jamais (bug de l'incident
// 07/2026). Start-Sleep ne dépend d'aucune console. Stop-Service -Force est
// tolérant (SilentlyContinue) : si le service est déjà arrêté, Start-Service
// le relance quand même.
//
// La fonction retourne dans tous les cas — c'est au caller de quitter
// le service proprement (sortir de la boucle Run) après l'appel.
func restartService() error {
	svc := branding.ServiceName
	ps := "Start-Sleep -Seconds 5; " +
		"Stop-Service -Force -Name '" + svc + "' -ErrorAction SilentlyContinue; " +
		"Start-Service -Name '" + svc + "'"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
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
