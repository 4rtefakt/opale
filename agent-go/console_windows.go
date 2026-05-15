//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/UserExistsError/conpty"
)

// Implémentation Windows : ConPTY natif (Win10 1809+) via la lib pure-Go
// UserExistsError/conpty. Pas de CGO, pas de DLL embarquée.
//
// Le ConPTY tourne dans le contexte SYSTEM (l'agent est un service SYSTEM)
// — un admin remote a donc des droits plus larges que via SSH vers un
// compte local non-SYSTEM. L'audit est fait côté serveur ; côté agent on
// signale l'utilisateur via toast OS.

type conptyAdapter struct {
	c *conpty.ConPty
}

func (a *conptyAdapter) Read(p []byte) (int, error)   { return a.c.Read(p) }
func (a *conptyAdapter) Write(p []byte) (int, error)  { return a.c.Write(p) }
func (a *conptyAdapter) Close() error                  { return a.c.Close() }
func (a *conptyAdapter) Resize(cols, rows uint16) error { return a.c.Resize(int(cols), int(rows)) }
func (a *conptyAdapter) PID() int                      { return a.c.Pid() }

func spawnConsole(shell string, cols, rows uint16) (consolePTY, error) {
	if !conpty.IsConPtyAvailable() {
		return nil, fmt.Errorf("ConPTY non supporté (Windows < 10 1809 ?)")
	}
	if shell == "" {
		shell = "powershell.exe"
	}
	cpty, err := conpty.Start(shell, conpty.ConPtyDimensions(int(cols), int(rows)))
	if err != nil {
		return nil, fmt.Errorf("conpty.Start(%q) : %w", shell, err)
	}
	return &conptyAdapter{c: cpty}, nil
}

func wsCapabilitiesPlatform() []string {
	return []string{"console"}
}

// notifyConsoleOpened — toast OS (RGPD) qui informe l'utilisateur qu'un
// admin a ouvert une console sur son poste. Utilise msg.exe qui traverse
// l'isolation Session 0 (SYSTEM → session utilisateur) — disponible sur
// Pro/Enterprise, absent sur Home. Non bloquant et silencieux en cas
// d'échec : la charte signée par l'utilisateur reste la garantie légale,
// le toast est un confort UX additionnel.
func notifyConsoleOpened(sessionID string) {
	// Message court : msg.exe a un timeout par défaut et ne supporte pas
	// les caractères trop exotiques. Format minimaliste.
	msg := fmt.Sprintf(
		"[Opale] Un administrateur vient d'ouvrir une console sur ce poste. "+
			"Session : %s.", strings.TrimSpace(sessionID[:8]))
	cmd := exec.Command("msg.exe", "*", "/TIME:10", msg)
	if err := cmd.Run(); err != nil {
		logWarn("toast-user-fail", "", LogFields{"error": err.Error()})
	}
}
