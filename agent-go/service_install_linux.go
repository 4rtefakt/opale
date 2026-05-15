//go:build linux

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

// Install/Uninstall side du service systemd. Convention :
//   - dataDir système : /etc/<lower(DataDirName)>  (mode 0700, root)
//   - binaire installé : $dataDir/<BinName>
//   - unit file : /etc/systemd/system/<ServiceName>.service
//   - le unit définit RMM_DATA_DIR=$dataDir → l'agent runtime y trouve
//     config.json, state.json, et son propre binaire (pour l'auto-update).
//
// L'install est idempotente : re-lancer met à jour le binaire + le unit
// + la config (si nouveaux --token/--url) puis fait daemon-reload + restart.

// InstallService — installe ou met à jour le service systemd. Prérequis :
// root. Si --token/--url sont fournis, écrit/écrase config.json avec ces
// valeurs ; sinon, exige qu'un config.json valide existe déjà au dataDir.
func InstallService(token, url string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("doit être lancé en root (essayez sudo)")
	}
	if !systemdAvailable() {
		return fmt.Errorf("systemd introuvable (/run/systemd/system absent)")
	}

	dst := serviceDataDirLinux()
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return fmt.Errorf("mkdir %s : %w", dst, err)
	}
	if err := os.Chmod(dst, 0o700); err != nil {
		return fmt.Errorf("chmod %s : %w", dst, err)
	}

	binDst := filepath.Join(dst, branding.BinName)
	if err := copyCurrentBinary(binDst); err != nil {
		return err
	}

	cfgPath := filepath.Join(dst, "config.json")
	if token != "" || url != "" {
		if err := writeInstallConfig(cfgPath, token, url); err != nil {
			return err
		}
		fmt.Printf("→ config écrite : %s\n", cfgPath)
	} else if _, err := os.Stat(cfgPath); err != nil {
		return fmt.Errorf("config.json absent (%s) — fournissez --token et --url, ou copiez la config manuellement avant", cfgPath)
	}

	unitPath := systemdUnitPath()
	unit := generateSystemdUnit(binDst, dst)
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("write %s : %w", unitPath, err)
	}
	fmt.Printf("→ unit écrit : %s\n", unitPath)

	// daemon-reload pour prendre en compte le unit, enable+now pour démarrer
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload : %w (%s)", err, strings.TrimSpace(string(out)))
	}
	unitName := branding.ServiceName + ".service"
	if out, err := exec.Command("systemctl", "enable", "--now", unitName).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable --now %s : %w (%s)", unitName, err, strings.TrimSpace(string(out)))
	}
	fmt.Printf("✓ service %s installé et démarré\n", unitName)
	fmt.Printf("   logs : journalctl -u %s -f\n", unitName)
	return nil
}

// UninstallService — stop + disable + supprime le unit. Conserve dataDir
// (config.json, state.json) pour permettre un re-install sans reconfig.
// L'utilisateur peut nettoyer le dataDir manuellement si désiré.
func UninstallService() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("doit être lancé en root (essayez sudo)")
	}

	unitName := branding.ServiceName + ".service"
	// Stop+disable best-effort — un service déjà arrêté n'est pas une erreur
	_ = exec.Command("systemctl", "stop", unitName).Run()
	_ = exec.Command("systemctl", "disable", unitName).Run()

	unitPath := systemdUnitPath()
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s : %w", unitPath, err)
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload : %w (%s)", err, strings.TrimSpace(string(out)))
	}

	fmt.Printf("✓ service %s désinstallé\n", unitName)
	fmt.Printf("   dataDir conservé : %s (supprimer manuellement si désiré)\n", serviceDataDirLinux())
	return nil
}

func serviceDataDirLinux() string {
	return filepath.Join("/etc", strings.ToLower(branding.DataDirName))
}

func systemdUnitPath() string {
	return filepath.Join("/etc/systemd/system", branding.ServiceName+".service")
}

// systemdAvailable — détection sommaire mais fiable : /run/systemd/system
// n'existe que si systemd est PID 1.
func systemdAvailable() bool {
	st, err := os.Stat("/run/systemd/system")
	return err == nil && st.IsDir()
}

func generateSystemdUnit(binPath, dataDir string) string {
	// Restart=always pour que l'auto-update (qui exit après atomicReplace)
	// soit suivi d'un restart automatique sur le nouveau binaire.
	return fmt.Sprintf(`[Unit]
Description=%s
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s
Restart=always
RestartSec=5
User=root
Environment=RMM_DATA_DIR=%s
StandardOutput=journal
StandardError=journal
# Le service tourne en root pour pouvoir lire les capteurs HW (DMI, batterie,
# etc.) et installer les MAJ système. Hardening minimal compatible :
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=%s
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`, branding.ServiceDescription, binPath, dataDir, dataDir)
}

func copyCurrentBinary(dst string) error {
	src, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable : %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(src); err == nil {
		src = resolved
	}
	if src == dst {
		// Déjà installé au bon endroit (ré-install depuis le binaire de prod)
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s : %w", src, err)
	}
	defer in.Close()

	// Atomique : écrire en .new puis rename.
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

func writeInstallConfig(path, token, url string) error {
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
