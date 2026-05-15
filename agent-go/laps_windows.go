//go:build windows

package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// setLocalAdminPassword crée le compte si nécessaire, le met dans le
// groupe Administrateurs local, active le compte et fixe le mot de passe.
//
// Le password n'apparaît JAMAIS dans la ligne de commande ni dans un
// fichier sur disque : on le passe via stdin (pipe) à PowerShell qui le
// lit en SecureString. Le seul lieu où il existe en mémoire est :
//   1. l'agent (cleared by GC après envoi)
//   2. le pipe (transient)
//   3. la mémoire de la lsass (système OS, normal)
func setLocalAdminPassword(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("username/password vide")
	}
	// Sécurité : refuse les noms communs d'admins existants pour éviter
	// un lockout si la config est mal renseignée.
	low := strings.ToLower(username)
	for _, banned := range []string{"administrator", "administrateur", "admin", "root", "system"} {
		if low == banned {
			return fmt.Errorf("username interdit (compte sensible) : %s", username)
		}
	}

	// Le script utilise des string normales Go (pas raw, pour éviter les
	// conflits d'interprétation avec les caractères PS) — donc tous les
	// backticks PS sont échappés. On évite la continuation de ligne PS et
	// on garde des instructions monoligne.
	// Description du compte lue depuis env (LAPS_DESC) — évite d'injecter
	// un littéral PS via concaténation et le risque de quote-escaping.
	script := "" +
		"$ErrorActionPreference = 'Stop';" +
		"$user = $env:LAPS_USER;" +
		"$desc = $env:LAPS_DESC;" +
		"$plain = [Console]::In.ReadLine();" +
		"$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force;" +
		"$plain = $null;" +
		"$existing = Get-LocalUser -Name $user -ErrorAction SilentlyContinue;" +
		"if (-not $existing) {" +
		"  New-LocalUser -Name $user -Password $secure -AccountNeverExpires -Description $desc | Out-Null;" +
		"} else {" +
		"  Set-LocalUser -Name $user -Password $secure;" +
		"}" +
		"Enable-LocalUser -Name $user;" +
		"$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544');" +
		"$grp = $sid.Translate([System.Security.Principal.NTAccount]).Value -replace '.*\\\\','';" +
		"$members = @(Get-LocalGroupMember -Name $grp | ForEach-Object { ($_.Name -replace '.*\\\\','') });" +
		"if ($members -notcontains $user) { Add-LocalGroupMember -Name $grp -Member $user; }"

	c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(cmd.Env,
		"LAPS_USER="+username,
		"LAPS_DESC="+branding.LAPSAccountDescription,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe : %w", err)
	}
	out, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe : %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start : %w", err)
	}
	// Envoie le password puis ferme stdin pour que PS sorte de ReadLine.
	if _, err := stdin.Write([]byte(password + "\r\n")); err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("stdin write : %w", err)
	}
	stdin.Close()

	// Capture stderr pour le diagnostic.
	errBuf := make([]byte, 0, 2048)
	buf := make([]byte, 1024)
	for {
		n, _ := out.Read(buf)
		if n > 0 {
			errBuf = append(errBuf, buf[:n]...)
		}
		if n == 0 {
			break
		}
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("PS exit : %w — stderr: %s", err, strings.TrimSpace(string(errBuf)))
	}
	return nil
}
