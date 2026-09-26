package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Scripts PowerShell de la LAPS et interprétation de leur résultat. Fichier
// sans build tag : la logique d'interprétation est testée hors Windows, la
// couche d'exécution (laps_windows.go) reste mince.

// Codes de sortie des scripts LAPS.
const (
	lapsExitOK             = 0
	lapsExitNotFound       = 3  // lookup : compte absent
	lapsExitRefused        = 10 // apply : état du compte différent du lookup, rien touché
	lapsExitSetFailed      = 11 // New-LocalUser / Set-LocalUser en échec : mdp inchangé
	lapsExitChangedPartial = 12 // mdp changé, activation / groupe en échec
)

// lapsLookupScript — SID et description du compte LAPS_USER. La
// description sort en base64 UTF-8 : la sortie console d'un process sans
// console suit la page de code OEM, qui abîmerait les accents d'une
// description brandée.
const lapsLookupScript = "" +
	"$ErrorActionPreference = 'Stop';" +
	"$u = Get-LocalUser -Name $env:LAPS_USER -ErrorAction SilentlyContinue;" +
	"if (-not $u) { exit 3 };" +
	"$d = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$u.Description));" +
	"[Console]::Out.WriteLine('SID=' + $u.SID.Value);" +
	"[Console]::Out.WriteLine('DESC64=' + $d);" +
	"exit 0"

// parseLAPSLookup — interprète la sortie de lapsLookupScript.
func parseLAPSLookup(stdout string, exitCode int) (lapsAccount, error) {
	switch exitCode {
	case lapsExitNotFound:
		return lapsAccount{Exists: false}, nil
	case lapsExitOK:
	default:
		return lapsAccount{}, fmt.Errorf("lookup : PS exit %d", exitCode)
	}
	acct := lapsAccount{Exists: true}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "SID="):
			acct.SID = strings.TrimPrefix(line, "SID=")
		case strings.HasPrefix(line, "DESC64="):
			raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(line, "DESC64="))
			if err != nil {
				return lapsAccount{}, fmt.Errorf("lookup : description illisible : %w", err)
			}
			acct.Description = string(raw)
		}
	}
	if acct.SID == "" {
		return lapsAccount{}, fmt.Errorf("lookup : SID absent de la sortie")
	}
	return acct, nil
}

// lapsApplyScript — mode "create" : crée le compte (avec la description
// branding), refuse s'il existe déjà ; mode "update" : change le mot de
// passe du compte, refuse si son SID n'est plus celui vérifié par
// checkLAPSAccountManageable. Puis l'active et l'ajoute au groupe
// Administrateurs (SID S-1-5-32-544, indépendant de la langue).
//
// Le mode et le SID attendu (LAPS_MODE, LAPS_EXPECTED_SID) viennent du
// lookup : le script revérifie juste avant d'agir (défense en profondeur
// contre un changement du compte entre les deux appels).
//
// Le mot de passe arrive par stdin, jamais en argument ni sur disque.
// Chaque étape est encadrée pour que le code de sortie dise si le mot de
// passe a changé (cf. classifyLAPSApplyExit) ; toute erreur non encadrée
// (exit 1 de PowerShell) est traitée comme incertaine.
//
// Le SID est écrit sur stdout dès que le mot de passe est en place (avant
// activation / groupe) : même en échec partiel (exit 12), l'agent mémorise
// le compte qu'il vient de créer.
//
// Ajout au groupe : Add-LocalGroupMember -SID, en tolérant « déjà membre »,
// plutôt que Get-LocalGroupMember qui échoue sur les postes joints Entra
// (SID orphelins / AzureAD dans le groupe).
//
// Chaînes Go normales concaténées, instructions monoligne séparées par des
// « ; » (pas de continuation de ligne PowerShell).
const lapsApplyScript = "" +
	"$ErrorActionPreference = 'Stop';" +
	"$user = $env:LAPS_USER;" +
	"$desc = $env:LAPS_DESC;" +
	"$mode = $env:LAPS_MODE;" +
	"$expectedSid = $env:LAPS_EXPECTED_SID;" +
	"$plain = [Console]::In.ReadLine();" +
	"$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force;" +
	"$plain = $null;" +
	"try { $existing = Get-LocalUser -Name $user -ErrorAction SilentlyContinue; }" +
	" catch { [Console]::Error.WriteLine($_.Exception.Message); exit 10 };" +
	"if ($mode -eq 'create') {" +
	" if ($existing) { [Console]::Error.WriteLine('compte apparu depuis le lookup'); exit 10 };" +
	" try { New-LocalUser -Name $user -Password $secure -AccountNeverExpires -Description $desc | Out-Null; }" +
	" catch { [Console]::Error.WriteLine($_.Exception.Message); exit 11 };" +
	"} elseif ($mode -eq 'update') {" +
	" if (-not $existing) { [Console]::Error.WriteLine('compte disparu depuis le lookup'); exit 10 };" +
	" if ([string]$existing.SID.Value -ne $expectedSid) { [Console]::Error.WriteLine('SID inattendu'); exit 10 };" +
	" try { Set-LocalUser -Name $user -Password $secure; }" +
	" catch { [Console]::Error.WriteLine($_.Exception.Message); exit 11 };" +
	"} else { [Console]::Error.WriteLine('mode inconnu'); exit 10 };" +
	"try { [Console]::Out.WriteLine('SID=' + (Get-LocalUser -Name $user).SID.Value); } catch { };" +
	"try {" +
	" Enable-LocalUser -Name $user;" +
	" try { Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $user -ErrorAction Stop; }" +
	" catch { if ([string]$_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw }; };" +
	"} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 };" +
	"exit 0"

// classifyLAPSApplyExit — traduit l'exécution du script en issue pour la
// machine à états. started=false : PowerShell n'a jamais démarré, rien n'a
// pu changer. timedOut : tué en cours de route, issue inconnue.
func classifyLAPSApplyExit(started bool, exitCode int, timedOut bool) lapsSetOutcome {
	if !started {
		return lapsSetUnchanged
	}
	if timedOut {
		return lapsSetUncertain
	}
	switch exitCode {
	case lapsExitOK:
		return lapsSetOK
	case lapsExitRefused, lapsExitSetFailed:
		return lapsSetUnchanged
	case lapsExitChangedPartial:
		return lapsSetChangedPartial
	}
	return lapsSetUncertain
}

// parseLAPSSID — extrait la ligne « SID=... » de la sortie du script.
func parseLAPSSID(stdout string) string {
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "SID=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "SID="))
		}
	}
	return ""
}

// lapsExitStatus — code de sortie d'un script LAPS terminé et s'il a été
// tué par son timeout. Un script sorti seul (même pile à l'échéance) ou
// dont un sous-process a gardé les pipes ouverts (exec.ErrWaitDelay,
// statut de succès) n'est pas un timeout : son code fait foi.
func lapsExitStatus(waitErr error, ps *os.ProcessState, ctxErr error) (exitCode int, timedOut bool) {
	exitCode = -1
	if ps != nil {
		exitCode = ps.ExitCode()
	}
	if waitErr == nil || errors.Is(waitErr, exec.ErrWaitDelay) {
		return exitCode, false
	}
	return exitCode, errors.Is(ctxErr, context.DeadlineExceeded)
}
