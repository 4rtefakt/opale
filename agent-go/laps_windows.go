//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// lapsScriptTimeout — borne d'exécution d'un script LAPS PowerShell.
const lapsScriptTimeout = 60 * time.Second

type windowsLAPSAccounts struct{}

func platformLAPSAccounts() lapsAccountStore { return windowsLAPSAccounts{} }

// lookup — SID et description du compte (cf. lapsLookupScript).
func (windowsLAPSAccounts) lookup(username string) (lapsAccount, error) {
	if username == "" {
		return lapsAccount{}, errors.New("username vide")
	}
	stdout, stderr, exitCode, _, _, err := runLAPSPowerShell(lapsLookupScript, []string{
		"LAPS_USER=" + username,
	}, "")
	acct, perr := parseLAPSLookup(stdout, exitCode)
	if perr != nil {
		return lapsAccount{}, fmt.Errorf("%w (err: %v, stderr: %s)", perr, err, strings.TrimSpace(stderr))
	}
	return acct, nil
}

// apply crée le compte (acct.Exists=false) ou change le mot de passe du
// compte acct.SID, puis l'active et le met dans le groupe Administrateurs
// local (cf. lapsApplyScript).
//
// Le password n'apparaît JAMAIS dans la ligne de commande ni dans un
// fichier sur disque : on le passe via stdin (pipe) à PowerShell qui le
// lit en SecureString. Le seul lieu où il existe en mémoire est :
//  1. l'agent (cleared by GC après envoi)
//  2. le pipe (transient)
//  3. la mémoire de la lsass (système OS, normal)
func (windowsLAPSAccounts) apply(username, password string, acct lapsAccount) lapsApplyResult {
	if username == "" || password == "" {
		return lapsApplyResult{Outcome: lapsSetUnchanged, Err: errors.New("username/password vide")}
	}
	if err := checkLAPSUsernameAllowed(username); err != nil {
		return lapsApplyResult{Outcome: lapsSetUnchanged, Err: err}
	}
	mode := "update"
	if !acct.Exists {
		mode = "create"
	}
	stdout, stderr, exitCode, started, timedOut, err := runLAPSPowerShell(lapsApplyScript, []string{
		"LAPS_USER=" + username,
		"LAPS_DESC=" + branding.LAPSAccountDescription,
		"LAPS_MODE=" + mode,
		"LAPS_EXPECTED_SID=" + acct.SID,
	}, password)
	res := lapsApplyResult{
		Outcome: classifyLAPSApplyExit(started, exitCode, timedOut),
		SID:     parseLAPSSID(stdout),
	}
	if res.Outcome != lapsSetOK {
		res.Err = fmt.Errorf("PS exit %d : %v — stderr: %s", exitCode, err, strings.TrimSpace(stderr))
	}
	return res
}

// runLAPSPowerShell — exécute un script -Command avec un environnement
// complété (le service tourne en SYSTEM) et stdin optionnel. Retourne
// stdout, stderr, le code de sortie, si le process a démarré et s'il a été
// tué par le timeout.
func runLAPSPowerShell(script string, env []string, stdin string) (stdout, stderr string, exitCode int, started, timedOut bool, err error) {
	c, cancel := context.WithTimeout(context.Background(), lapsScriptTimeout)
	defer cancel()
	cmd := exec.CommandContext(c, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.WaitDelay = 5 * time.Second
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin + "\r\n")
	}
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err = cmd.Start(); err != nil {
		return "", "", -1, false, false, fmt.Errorf("start : %w", err)
	}
	err = cmd.Wait()
	exitCode, timedOut = lapsExitStatus(err, cmd.ProcessState, c.Err())
	return outBuf.String(), errBuf.String(), exitCode, true, timedOut, err
}
