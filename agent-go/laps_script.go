package main

import "strings"

// Scripts PowerShell de la LAPS et interprétation de leur résultat. Fichier
// sans build tag : la logique d'interprétation est testée hors Windows, la
// couche d'exécution (laps_windows.go) reste mince.

// Codes de sortie du script d'application (lapsApplyScript).
const (
	lapsExitOK             = 0
	lapsExitSetFailed      = 11 // New-LocalUser / Set-LocalUser en échec : mdp inchangé
	lapsExitChangedPartial = 12 // mdp changé, activation / groupe en échec
)

// lapsApplyScript — crée le compte si nécessaire (avec la description
// branding), sinon change son mot de passe ; puis l'active et l'ajoute au
// groupe Administrateurs (SID S-1-5-32-544, indépendant de la langue).
//
// Le mot de passe arrive par stdin, jamais en argument ni sur disque.
// Chaque étape est encadrée pour que le code de sortie dise si le mot de
// passe a changé (cf. classifyLAPSApplyExit) ; toute erreur non encadrée
// (exit 1 de PowerShell) est traitée comme incertaine.
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
	"$plain = [Console]::In.ReadLine();" +
	"$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force;" +
	"$plain = $null;" +
	"try {" +
	" $existing = Get-LocalUser -Name $user -ErrorAction SilentlyContinue;" +
	" if (-not $existing) {" +
	"  New-LocalUser -Name $user -Password $secure -AccountNeverExpires -Description $desc | Out-Null;" +
	" } else {" +
	"  Set-LocalUser -Name $user -Password $secure;" +
	" };" +
	"} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 11 };" +
	"try {" +
	" Enable-LocalUser -Name $user;" +
	" try { Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $user -ErrorAction Stop; }" +
	" catch { if ([string]$_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw }; };" +
	" [Console]::Out.WriteLine('SID=' + (Get-LocalUser -Name $user).SID.Value);" +
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
	case lapsExitSetFailed:
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
