//go:build darwin

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// Install/Uninstall side du service launchd. Convention :
//   - dataDir système : /Library/Application Support/<DataDirName>
//   - binaire installé : $dataDir/<BinName>
//   - plist : /Library/LaunchDaemons/<launchdLabel>.plist
//   - le plist définit RMM_DATA_DIR=$dataDir → l'agent runtime y trouve
//     config.json, state.json, et son propre binaire.
//
// L'install est idempotente : re-lancer met à jour le binaire + le plist
// + (optionnel) la config puis fait un kickstart -k pour redémarrer.

// InstallService — installe ou met à jour le LaunchDaemon. Prérequis : root.
// Si --token/--url fournis, écrit/écrase config.json ; sinon exige qu'un
// config.json valide existe déjà.
func InstallService(token, url string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("doit être lancé en root (essayez sudo)")
	}

	dst := serviceDataDirDarwin()
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return fmt.Errorf("mkdir %s : %w", dst, err)
	}
	if err := os.Chmod(dst, 0o700); err != nil {
		return fmt.Errorf("chmod %s : %w", dst, err)
	}

	binDst := filepath.Join(dst, branding.BinName)
	if err := copyCurrentBinaryDarwin(binDst); err != nil {
		return err
	}

	cfgPath := filepath.Join(dst, "config.json")
	if token != "" || url != "" {
		if err := writeInstallConfigDarwin(cfgPath, token, url); err != nil {
			return err
		}
		fmt.Printf("→ config écrite : %s\n", cfgPath)
	} else if _, err := os.Stat(cfgPath); err != nil {
		return fmt.Errorf("config.json absent (%s) — fournissez --token et --url, ou copiez la config manuellement avant", cfgPath)
	}

	label := launchdLabel()
	plistPath := launchdPlistPath()
	plist := generateLaunchdPlist(label, binDst, dst)
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return fmt.Errorf("write %s : %w", plistPath, err)
	}
	if err := os.Chown(plistPath, 0, 0); err != nil {
		return fmt.Errorf("chown %s : %w", plistPath, err)
	}
	fmt.Printf("→ plist écrit : %s\n", plistPath)

	// Si déjà chargé, on bootout d'abord pour repartir propre. bootout sur
	// un service inexistant retourne une erreur qu'on ignore.
	target := "system/" + label
	_ = exec.Command("launchctl", "bootout", target).Run()

	if out, err := exec.Command("launchctl", "bootstrap", "system", plistPath).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap %s : %w (%s)", plistPath, err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("launchctl", "kickstart", "-k", target).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl kickstart %s : %w (%s)", target, err, strings.TrimSpace(string(out)))
	}

	fmt.Printf("✓ service %s installé et démarré\n", label)
	fmt.Printf("   logs : tail -f /var/log/%s.log\n", branding.BinName)
	return nil
}

// UninstallService — bootout + remove plist. Conserve dataDir comme sur Linux.
func UninstallService() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("doit être lancé en root (essayez sudo)")
	}
	label := launchdLabel()
	target := "system/" + label
	_ = exec.Command("launchctl", "bootout", target).Run()

	plistPath := launchdPlistPath()
	if err := os.Remove(plistPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s : %w", plistPath, err)
	}
	fmt.Printf("✓ service %s désinstallé\n", label)
	fmt.Printf("   dataDir conservé : %s (supprimer manuellement si désiré)\n", serviceDataDirDarwin())
	return nil
}

func serviceDataDirDarwin() string {
	return filepath.Join("/Library/Application Support", branding.DataDirName)
}

// launchdLabel — convention reverse-DNS Apple. Format : com.<brand>.<bin>.
// Brand = DataDirName en minuscules, espaces et tirets supprimés.
func launchdLabel() string {
	brand := strings.ToLower(branding.DataDirName)
	brand = strings.ReplaceAll(brand, " ", "")
	brand = strings.ReplaceAll(brand, "-", "")
	if brand == "" {
		brand = "agent"
	}
	return "com." + brand + "." + branding.BinName
}

func launchdPlistPath() string {
	return filepath.Join("/Library/LaunchDaemons", launchdLabel()+".plist")
}

// generateLaunchdPlist — KeepAlive.SuccessfulExit=false évite que launchd
// abandonne le service si l'agent exit 0 (cas de l'auto-update). Combiné à
// RunAtLoad+KeepAlive, ça garantit un redémarrage automatique.
func generateLaunchdPlist(label, binPath, dataDir string) string {
	logPath := "/var/log/" + branding.BinName + ".log"
	errPath := "/var/log/" + branding.BinName + ".err.log"
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>UserName</key>
    <string>root</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>RMM_DATA_DIR</key>
        <string>%s</string>
    </dict>
    <key>StandardOutPath</key>
    <string>%s</string>
    <key>StandardErrorPath</key>
    <string>%s</string>
</dict>
</plist>
`, label, binPath, dataDir, logPath, errPath)
}

func copyCurrentBinaryDarwin(dst string) error {
	src, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable : %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(src); err == nil {
		src = resolved
	}
	if src == dst {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s : %w", src, err)
	}
	defer in.Close()

	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("create %s : %w", tmp, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("copy : %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close %s : %w", tmp, err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s → %s : %w", tmp, dst, err)
	}
	fmt.Printf("→ binaire installé : %s\n", dst)
	return nil
}

func writeInstallConfigDarwin(path, token, url string) error {
	if token == "" || url == "" {
		return fmt.Errorf("--token et --url doivent être fournis ensemble")
	}
	if !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("--url doit être en https:// (reçu %q)", url)
	}
	cfg := Config{Token: token, URL: strings.TrimRight(url, "/")}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s : %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename : %w", err)
	}
	return nil
}
