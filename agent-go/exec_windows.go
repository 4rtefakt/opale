//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// scriptTimeout — limite par script. inventory.ps1 limite la tâche planifiée
// à 5 min ; on garde la même valeur pour les scripts individuels.
const scriptTimeout = 5 * time.Minute

// runPowerShell exécute un script PS en passant par un fichier temporaire,
// retourne (exitCode, output combiné stdout+stderr).
func runPowerShell(ctx context.Context, script string) (int, string) {
	if strings.TrimSpace(script) == "" {
		return 1, "script vide"
	}
	f, err := os.CreateTemp("", branding.TempScriptPrefix+"*.ps1")
	if err != nil {
		return 1, fmt.Sprintf("CreateTemp : %v", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(script); err != nil {
		_ = f.Close()
		return 1, fmt.Sprintf("write temp : %v", err)
	}
	if err := f.Close(); err != nil {
		return 1, fmt.Sprintf("close temp : %v", err)
	}

	c, cancel := context.WithTimeout(ctx, scriptTimeout)
	defer cancel()
	cmd := exec.CommandContext(c, "powershell.exe",
		"-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f.Name())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	out, err := cmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		switch {
		case errors.As(err, &exitErr):
			exitCode = exitErr.ExitCode()
		case errors.Is(c.Err(), context.DeadlineExceeded):
			exitCode = 124 // convention Unix timeout — l'API ne fait que le stocker
			out = append(out, []byte("\n[timeout après "+scriptTimeout.String()+"]")...)
		default:
			exitCode = 1
			out = append(out, []byte("\nerror : "+err.Error())...)
		}
	}
	return exitCode, strings.TrimSpace(string(out))
}

// findWinget — winget n'est pas dans le PATH en contexte SYSTEM. On le cherche
// dans WindowsApps (équivalent du Get-ChildItem … Sort … Select Last 1 du PS).
func findWinget() string {
	if p, err := exec.LookPath("winget.exe"); err == nil {
		return p
	}
	matches, _ := filepath.Glob(`C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe`)
	if len(matches) > 0 {
		sort.Strings(matches)
		return matches[len(matches)-1]
	}
	return ""
}

// progressLineRe — lignes de progression à filtrer (ex. "1.2 MB / 3.4 MB")
var progressLineRe = regexp.MustCompile(`\d+(\.\d+)?\s*(KB|MB|GB)\s*/\s*\d`)
var alphaLineRe   = regexp.MustCompile(`[a-zA-Z]`)

func filterWingetOutput(raw string) string {
	keep := make([]string, 0, 16)
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		if !alphaLineRe.MatchString(line) {
			continue
		}
		if progressLineRe.MatchString(line) {
			continue
		}
		keep = append(keep, line)
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

// runWingetInstall reproduit la branche winget de inventory.ps1 :
// install machine-wide silent, traite "déjà installé" comme succès.
func runWingetInstall(ctx context.Context, wingetID string) (int, string) {
	winget := findWinget()
	if winget == "" {
		return 1, "winget introuvable (contexte SYSTEM)"
	}
	c, cancel := context.WithTimeout(ctx, scriptTimeout)
	defer cancel()
	cmd := exec.CommandContext(c, winget, "install",
		"--id", wingetID,
		"--scope", "machine",
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()

	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}
	// Codes "déjà installé / pas d'update dispo" → succès. Cf. inventory.ps1
	// (les valeurs en uint32 = négatives en int32).
	switch uint32(exitCode) {
	case 0x8A150007, // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
		 0x8A150019: // pas de mise à jour disponible
		exitCode = 0
	}
	return exitCode, filterWingetOutput(string(out))
}

// processCommands exécute les script_executions et POSTe chaque résultat.
// Match le bloc "Scripts en attente" de inventory.ps1.
func processCommands(ctx context.Context, cfg *Config, cmds []Command) {
	for _, cmd := range cmds {
		exitCode, output := runPowerShell(ctx, cmd.Script)
		logInfo("command-run", "", LogFields{
			"id":           cmd.ID,
			"name":         cmd.Name,
			"exit_code":    exitCode,
			"output_bytes": len(output),
		})
		if err := postCommandResult(ctx, cfg, cmd.ID, exitCode, output); err != nil {
			logWarn("command-result-post-fail", "POST result échoué (non bloquant)", LogFields{
				"id":    cmd.ID,
				"error": err.Error(),
			})
		}
	}
}

// processDeployments exécute les déploiements (winget ou script) et leurs
// scripts post-install + detection_script. Retourne deux slices à remonter
// au prochain checkin.
func processDeployments(ctx context.Context, deps []Deployment) ([]DeploymentResult, []DetectionResult) {
	var depResults []DeploymentResult
	var detResults []DetectionResult

	for _, d := range deps {
		var exitCode int
		var output string

		switch d.Type {
		case "winget":
			if d.WingetID == "" {
				exitCode, output = 1, "winget_id manquant"
			} else {
				exitCode, output = runWingetInstall(ctx, d.WingetID)
			}
		case "script":
			if d.InstallScript == "" {
				exitCode, output = 1, "install_script manquant"
			} else {
				exitCode, output = runPowerShell(ctx, d.InstallScript)
			}
		default:
			exitCode, output = 1, "type de déploiement inconnu : "+d.Type
		}
		logInfo("deployment-run", "", LogFields{
			"id":        d.DeploymentID,
			"name":      d.Name,
			"type":      d.Type,
			"exit_code": exitCode,
		})

		// Post-install (best-effort, append à output)
		if d.PostInstallScript != "" {
			_, postOut := runPowerShell(ctx, d.PostInstallScript)
			output = strings.TrimSpace(output + "\n[post-install]\n" + postOut)
		}

		depResults = append(depResults, DeploymentResult{
			DeploymentID: d.DeploymentID,
			ExitCode:     exitCode,
			Output:       output,
		})

		// Détection post-install : exit 0 = installé
		if d.DetectionScript != "" {
			detExit, _ := runPowerShell(ctx, d.DetectionScript)
			detResults = append(detResults, DetectionResult{
				PackageID: d.DeploymentID,
				Detected:  detExit == 0,
			})
		}
	}
	return depResults, detResults
}

// processDetect exécute les detection_scripts d'inventaire logiciel.
func processDetect(ctx context.Context, dets []Detect) []DetectionResult {
	out := make([]DetectionResult, 0, len(dets))
	for _, d := range dets {
		if d.DetectionScript == "" {
			continue
		}
		exitCode, _ := runPowerShell(ctx, d.DetectionScript)
		out = append(out, DetectionResult{
			PackageID: d.PackageID,
			Detected:  exitCode == 0,
		})
	}
	return out
}
