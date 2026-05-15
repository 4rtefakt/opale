//go:build windows

package main

import (
	"errors"
	"sort"
	"time"

	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows/registry"
)

// collectHealth — exécute les sondes en parallèle ne serait pas un gros
// gain (WMI total ~300ms) ; on les fait en série pour rester simple.
// Toute erreur sur une sonde se traduit par un champ absent (omitempty).
func collectHealth() *HealthSignals {
	h := &HealthSignals{
		BitLocker:     collectBitLocker(),
		Defender:      collectDefender(),
		Firewall:      collectFirewall(),
		TPMPresent:    collectTPMPresent(),
		PendingReboot: collectPendingReboot(),
		LastWinUpdate: collectLastWindowsUpdate(),
	}
	return h
}

// ── BitLocker ─────────────────────────────────────────────────────────────
type win32EncryptableVolume struct {
	DriveLetter      string
	ProtectionStatus uint32
	EncryptionMethod uint32
}

func collectBitLocker() *BitLockerState {
	var rows []win32EncryptableVolume
	err := wmi.QueryNamespace(
		`SELECT DriveLetter, ProtectionStatus, EncryptionMethod FROM Win32_EncryptableVolume`,
		&rows,
		`root\CIMV2\Security\MicrosoftVolumeEncryption`,
	)
	if err != nil {
		logWarn("health-bitlocker-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	for _, v := range rows {
		if v.DriveLetter == "C:" {
			return &BitLockerState{
				Volume:           "C:",
				Enabled:          v.ProtectionStatus == 1,
				ProtectionStatus: protectionStatusName(v.ProtectionStatus),
				EncryptionMethod: encryptionMethodName(v.EncryptionMethod),
			}
		}
	}
	return nil
}

func protectionStatusName(s uint32) string {
	// 0 = Off, 1 = On, 2 = Unknown (Microsoft doc Win32_EncryptableVolume)
	switch s {
	case 0:
		return "off"
	case 1:
		return "on"
	default:
		return "unknown"
	}
}

func encryptionMethodName(m uint32) string {
	// Cf. Win32_EncryptableVolume.EncryptionMethod
	switch m {
	case 0:
		return "none"
	case 1:
		return "aes_128_diffuser"
	case 2:
		return "aes_256_diffuser"
	case 3:
		return "aes_128"
	case 4:
		return "aes_256"
	case 5:
		return "hardware"
	case 6:
		return "xts_aes_128"
	case 7:
		return "xts_aes_256"
	}
	return ""
}

// ── Windows Defender ──────────────────────────────────────────────────────
type msftMpComputerStatus struct {
	AntispywareEnabled            bool
	AntivirusEnabled              bool
	RealTimeProtectionEnabled     bool
	AntivirusSignatureLastUpdated time.Time
}

func collectDefender() *DefenderState {
	var rows []msftMpComputerStatus
	err := wmi.QueryNamespace(
		`SELECT AntispywareEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated FROM MSFT_MpComputerStatus`,
		&rows,
		`root\Microsoft\Windows\Defender`,
	)
	if err != nil {
		logWarn("health-defender-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	if len(rows) == 0 {
		return nil
	}
	r := rows[0]
	out := &DefenderState{
		AntivirusEnabled:   r.AntivirusEnabled,
		RealTimeProtection: r.RealTimeProtectionEnabled,
		AntispywareEnabled: r.AntispywareEnabled,
	}
	if !r.AntivirusSignatureLastUpdated.IsZero() {
		d := r.AntivirusSignatureLastUpdated.UTC().Format("2006-01-02")
		out.SignatureLastUpdate = &d
		age := int(time.Since(r.AntivirusSignatureLastUpdated).Hours() / 24)
		out.SignatureAgeDays = &age
	}
	// Threats history. Si la query échoue (Defender absent ou table non
	// exposée sur ce SKU), on garde les champs nil pour distinguer
	// "pas mesuré" de "0 threats".
	if c, last, ok := queryDefenderThreats(); ok {
		out.ThreatsLast30d = &c
		if !last.IsZero() {
			ls := last.UTC().Format("2006-01-02")
			out.LastThreatAt = &ls
		}
	}
	return out
}

// queryDefenderThreats compte les détections sur les 30 derniers jours et
// renvoie la plus récente. MSFT_MpThreatDetection contient l'historique
// même si Defender est désactivé maintenant — utile pour repérer un poste
// qui chope régulièrement des malware.
type msftMpThreatDetection struct {
	InitialDetectionTime time.Time
}

func queryDefenderThreats() (count int, last time.Time, ok bool) {
	var rows []msftMpThreatDetection
	if err := wmi.QueryNamespace(
		`SELECT InitialDetectionTime FROM MSFT_MpThreatDetection`,
		&rows,
		`root\Microsoft\Windows\Defender`,
	); err != nil {
		return 0, time.Time{}, false
	}
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	for _, r := range rows {
		if r.InitialDetectionTime.IsZero() {
			continue
		}
		if r.InitialDetectionTime.After(cutoff) {
			count++
		}
		if r.InitialDetectionTime.After(last) {
			last = r.InitialDetectionTime
		}
	}
	return count, last, true
}

// ── Firewall ──────────────────────────────────────────────────────────────
// MSFT_NetFirewallProfile expose 3 profils (Domain/Private/Public). Chaque
// profil a un champ Enabled (uint16 : 1=On, 2=Off).
type msftNetFirewallProfile struct {
	Name    string
	Enabled uint16
}

func collectFirewall() *FirewallState {
	var rows []msftNetFirewallProfile
	err := wmi.QueryNamespace(
		`SELECT Name, Enabled FROM MSFT_NetFirewallProfile`,
		&rows,
		`root\StandardCimv2`,
	)
	if err != nil {
		logWarn("health-firewall-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	out := &FirewallState{}
	for _, p := range rows {
		on := p.Enabled == 1
		switch p.Name {
		case "Domain":
			out.DomainEnabled = on
		case "Private":
			out.PrivateEnabled = on
		case "Public":
			out.PublicEnabled = on
		}
	}
	return out
}

// ── TPM ───────────────────────────────────────────────────────────────────
type win32Tpm struct {
	IsActivated_InitialValue bool
	IsEnabled_InitialValue   bool
}

func collectTPMPresent() *bool {
	var rows []win32Tpm
	err := wmi.QueryNamespace(
		`SELECT IsActivated_InitialValue, IsEnabled_InitialValue FROM Win32_Tpm`,
		&rows,
		`root\CIMV2\Security\MicrosoftTpm`,
	)
	if err != nil {
		// Pas de TPM (machine sans TPM) → erreur ACCESS_DENIED ou namespace
		// absent. On le considère comme "non présent" sans warner.
		f := false
		return &f
	}
	present := len(rows) > 0 && rows[0].IsActivated_InitialValue && rows[0].IsEnabled_InitialValue
	return &present
}

// ── Pending reboot ────────────────────────────────────────────────────────
// 3 sources canoniques selon Microsoft. Si l'une est positive → reboot pending.
func collectPendingReboot() *bool {
	pending := false

	// 1. Component Based Servicing
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
		registry.READ); err == nil {
		k.Close()
		pending = true
	}
	// 2. Windows Update Auto Update
	if !pending {
		if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
			`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
			registry.READ); err == nil {
			k.Close()
			pending = true
		}
	}
	// 3. PendingFileRenameOperations
	if !pending {
		if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
			`SYSTEM\CurrentControlSet\Control\Session Manager`,
			registry.READ); err == nil {
			defer k.Close()
			if _, _, err := k.GetStringsValue("PendingFileRenameOperations"); err == nil {
				pending = true
			} else if !errors.Is(err, registry.ErrNotExist) {
				// autre erreur, on ne marque pas pending
			}
		}
	}
	return &pending
}

// ── Dernier Windows Update installé ───────────────────────────────────────
type win32QFE struct {
	HotFixID    string
	InstalledOn string // chaîne dans le format local (ex. "10/05/2026")
}

func collectLastWindowsUpdate() *string {
	var rows []win32QFE
	if err := wmi.Query(`SELECT HotFixID, InstalledOn FROM Win32_QuickFixEngineering`, &rows); err != nil {
		logWarn("health-winupdate-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	dates := make([]time.Time, 0, len(rows))
	for _, r := range rows {
		if r.InstalledOn == "" {
			continue
		}
		t, ok := parseQFEDate(r.InstalledOn)
		if ok {
			dates = append(dates, t)
		}
	}
	if len(dates) == 0 {
		return nil
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].After(dates[j]) })
	d := dates[0].Format("2006-01-02")
	return &d
}

// parseQFEDate accepte les formats les plus courants vus sur Windows FR/EN :
// "1/2/2026", "01/02/2026", "2026-01-02".
func parseQFEDate(s string) (time.Time, bool) {
	formats := []string{
		"1/2/2006", "01/02/2006", "2/1/2006", "02/01/2006",
		"2006-01-02", "1/2/2006 0:00:00", "01/02/2006 00:00:00",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
