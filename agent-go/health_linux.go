//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// collectHealth — sondes de santé OS / sécurité Linux. Chaque sonde est
// best-effort : toute erreur se traduit par un champ absent (omitempty).
//
// Mapping vs Windows :
//   - BitLocker      → LUKS detection sur la racine (champ BitLocker, on
//                      réutilise le type pour ne pas casser le schéma)
//   - Defender       → ClamAV / status d'un service AV connu (best-effort)
//   - Firewall       → ufw / firewalld / nftables / iptables
//   - TPM            → présence /dev/tpm0 ou /sys/class/tpm/tpm0
//   - PendingReboot  → /var/run/reboot-required (Debian/Ubuntu) ou présence
//                      de needrestart artifacts (RHEL: /usr/bin/needs-restarting)
//   - LastWinUpdate  → date du dernier upgrade dpkg/rpm
func collectHealth() *HealthSignals {
	h := &HealthSignals{
		BitLocker:     collectLUKS(),
		Defender:      collectAVLinux(),
		Firewall:      collectFirewallLinux(),
		TPMPresent:    collectTPMLinux(),
		PendingReboot: collectPendingRebootLinux(),
		LastWinUpdate: collectLastUpdateLinux(),
	}
	return h
}

// ── LUKS (équivalent BitLocker) ───────────────────────────────────────────
// On considère "chiffré" si la racine "/" est sur un device dm-crypt.
// /proc/mounts → on récupère le device de "/", puis /sys/class/block/<dev>/dm/uuid
// existe et commence par "CRYPT-" si LUKS.
func collectLUKS() *BitLockerState {
	root := readRootDevice()
	if root == "" {
		return nil
	}
	enabled := isDeviceLUKS(root)
	state := "off"
	if enabled {
		state = "on"
	}
	return &BitLockerState{
		Volume:           "/",
		Enabled:          enabled,
		ProtectionStatus: state,
		EncryptionMethod: encMethodLUKS(enabled),
	}
}

func readRootDevice() string {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 && fields[1] == "/" {
			return fields[0]
		}
	}
	return ""
}

func isDeviceLUKS(dev string) bool {
	// dev = "/dev/mapper/cryptroot" ou "/dev/sdaN". On résout le nom
	// "court" pour aller chercher dans /sys/class/block.
	base := filepath.Base(dev)
	uuidPath := "/sys/class/block/" + base + "/dm/uuid"
	uuid := readTrimmedFile(uuidPath)
	if uuid == "" {
		// pas un device DM → pas LUKS direct (peut être chiffré sous-jacent
		// via partition LUKS + LVM, mais on s'arrête à 1 niveau)
		return false
	}
	return strings.HasPrefix(strings.ToUpper(uuid), "CRYPT-LUKS")
}

func encMethodLUKS(enabled bool) string {
	if enabled {
		return "luks_aes_xts" // valeur générique — `cryptsetup status` donnerait
		// la vraie cipher mais nécessite root + parsing supplémentaire.
	}
	return "none"
}

// ── Antivirus Linux (best-effort) ─────────────────────────────────────────
// Linux n'a pas de Defender intégré. On regarde s'il y a un AV connu
// installé/actif (ClamAV via clamd/freshclam, ESET, Sophos…). Sinon on
// renvoie un état "désactivé" pour signaler explicitement l'absence.
func collectAVLinux() *DefenderState {
	candidates := []string{"clamav-daemon", "clamd@scan", "clamd", "esets", "sophos-spl"}
	active := false
	for _, svc := range candidates {
		if isSystemdActive(svc) {
			active = true
			break
		}
	}
	out := &DefenderState{
		AntivirusEnabled:   active,
		RealTimeProtection: active, // on n'arrive pas à distinguer scheduled vs RT
		AntispywareEnabled: active,
	}
	if active {
		// Date des signatures clamav : /var/lib/clamav/main.c{l,v}d
		for _, p := range []string{"/var/lib/clamav/main.cvd", "/var/lib/clamav/daily.cvd", "/var/lib/clamav/main.cld"} {
			if st, err := os.Stat(p); err == nil {
				d := st.ModTime().UTC().Format("2006-01-02")
				out.SignatureLastUpdate = &d
				age := int(time.Since(st.ModTime()).Hours() / 24)
				out.SignatureAgeDays = &age
				break
			}
		}
	}
	return out
}

func isSystemdActive(unit string) bool {
	// `systemctl is-active <unit>` écrit "active" / "inactive" / "failed"
	// sur stdout — on évite --quiet qui n'écrit rien et oblige à se reposer
	// uniquement sur le code retour (que runCmd ne distingue pas du "0 + vide").
	out := runCmd(2*time.Second, "systemctl", "is-active", unit)
	return strings.TrimSpace(out) == "active"
}

// ── Firewall ──────────────────────────────────────────────────────────────
// Cascade de détection : ufw → firewalld → nftables → iptables.
// On expose les 3 champs Domain/Private/Public en miroir : Linux n'a pas la
// notion de "profil par réseau", donc tous les profils renvoient le même bool.
func collectFirewallLinux() *FirewallState {
	enabled, ok := detectFirewallEnabled()
	if !ok {
		return nil
	}
	return &FirewallState{
		DomainEnabled:  enabled,
		PrivateEnabled: enabled,
		PublicEnabled:  enabled,
	}
}

func detectFirewallEnabled() (bool, bool) {
	// ufw
	if _, err := os.Stat("/usr/sbin/ufw"); err == nil || fileExists("/usr/bin/ufw") {
		out := runCmd(2*time.Second, "ufw", "status")
		if out != "" {
			return strings.Contains(strings.ToLower(out), "status: active"), true
		}
	}
	// firewalld
	if isSystemdActive("firewalld") {
		return true, true
	}
	// nftables
	if isSystemdActive("nftables") {
		return true, true
	}
	// iptables : si systemd unit actif OU si la table filter a au moins 1 règle
	if isSystemdActive("iptables") {
		return true, true
	}
	out := runCmd(2*time.Second, "iptables", "-S")
	if out != "" {
		// Compte le nombre de règles non-default (autres que -P CHAIN ACCEPT)
		nonDefault := 0
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if strings.HasPrefix(line, "-P ") {
				continue
			}
			nonDefault++
		}
		return nonDefault > 0, true
	}
	return false, false
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ── TPM ───────────────────────────────────────────────────────────────────
func collectTPMLinux() *bool {
	present := fileExists("/dev/tpm0") || fileExists("/dev/tpmrm0") ||
		fileExists("/sys/class/tpm/tpm0")
	return &present
}

// ── Pending reboot ────────────────────────────────────────────────────────
// Debian/Ubuntu : présence /var/run/reboot-required.
// RHEL/Fedora   : `needs-restarting -r` exit 1 si reboot requis (paquet dnf-utils).
// Universel    : kernel courant != kernel le plus récent installé.
func collectPendingRebootLinux() *bool {
	// 1. Debian/Ubuntu marker
	if fileExists("/var/run/reboot-required") {
		t := true
		return &t
	}
	// 2. RHEL needs-restarting (best-effort, package optionnel)
	out := runCmd(3*time.Second, "needs-restarting", "-r")
	if strings.Contains(strings.ToLower(out), "reboot is required") {
		t := true
		return &t
	}
	// Pas de marker positif → on dit "non" plutôt que "inconnu". Un faux
	// négatif est moins grave qu'absence de signal côté UI.
	f := false
	return &f
}

// ── Dernier upgrade système ───────────────────────────────────────────────
// On scanne les logs du package manager :
//   - Debian/Ubuntu : /var/log/dpkg.log* (avec rotation .gz qu'on ne décompresse pas)
//   - RHEL/Fedora   : /var/log/dnf.rpm.log ou /var/log/yum.log
//   - Arch          : /var/log/pacman.log
var dpkgUpgradeRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\s+(?:upgrade|install)\s+`)

func collectLastUpdateLinux() *string {
	if d := lastUpgradeFromDpkg(); d != "" {
		return &d
	}
	if d := lastUpgradeFromRpm(); d != "" {
		return &d
	}
	if d := lastUpgradeFromPacman(); d != "" {
		return &d
	}
	return nil
}

func lastUpgradeFromDpkg() string {
	files, _ := filepath.Glob("/var/log/dpkg.log*")
	// On ne lit que les fichiers non compressés (skip .gz pour rester simple).
	var plain []string
	for _, p := range files {
		if !strings.HasSuffix(p, ".gz") {
			plain = append(plain, p)
		}
	}
	if len(plain) == 0 {
		return ""
	}
	sort.Strings(plain)
	// On lit en partant du plus récent (dpkg.log) en remontant vers les .1
	for i := len(plain) - 1; i >= 0; i-- {
		if d := scanLastDpkgUpgrade(plain[i]); d != "" {
			return d
		}
	}
	return ""
}

func scanLastDpkgUpgrade(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var last string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		m := dpkgUpgradeRe.FindStringSubmatch(sc.Text())
		if m != nil {
			last = m[1]
		}
	}
	return last
}

func lastUpgradeFromRpm() string {
	candidates := []string{"/var/log/dnf.rpm.log", "/var/log/dnf.log", "/var/log/yum.log"}
	for _, p := range candidates {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		// La dernière modif du log est un proxy raisonnable du dernier upgrade.
		return st.ModTime().UTC().Format("2006-01-02")
	}
	return ""
}

func lastUpgradeFromPacman() string {
	// /var/log/pacman.log lignes type "[2025-12-01T10:11:12+0000] [PACMAN] starting full system upgrade"
	st, err := os.Stat("/var/log/pacman.log")
	if err != nil {
		return ""
	}
	return st.ModTime().UTC().Format("2006-01-02")
}
