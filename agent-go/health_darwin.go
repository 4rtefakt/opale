//go:build darwin

package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// collectHealth — sondes de santé OS / sécurité macOS. Mapping vs Windows :
//   - BitLocker      → FileVault status (réutilise le type pour rester compat)
//   - Defender       → XProtect (signatures) + état de Gatekeeper / SIP
//                       comme proxy d'AV intégré
//   - Firewall       → Application Layer Firewall (defaults read alf)
//   - TPM            → Secure Enclave non exposable directement, on renvoie
//                       true sur Apple Silicon (T2/Secure Enclave intégré).
//   - PendingReboot  → softwareupdate --list montre "restart required"
//   - LastWinUpdate  → softwareupdate --history (parser du dernier install)
func collectHealth() *HealthSignals {
	return &HealthSignals{
		BitLocker:     collectFileVault(),
		Defender:      collectXProtect(),
		Firewall:      collectFirewallDarwin(),
		TPMPresent:    collectSecureEnclave(),
		PendingReboot: collectPendingRebootDarwin(),
		LastWinUpdate: collectLastUpdateDarwin(),
	}
}

// ── FileVault (équivalent BitLocker) ──────────────────────────────────────
// `fdesetup status` renvoie une ligne :
//   FileVault is On.
//   FileVault is Off.
//   FileVault is decrypting...
func collectFileVault() *BitLockerState {
	out := strings.ToLower(runCmd(3*time.Second, "fdesetup", "status"))
	if out == "" {
		return nil
	}
	enabled := strings.Contains(out, "filevault is on")
	state := "off"
	if enabled {
		state = "on"
	}
	method := "none"
	if enabled {
		method = "xts_aes_128" // FileVault 2 utilise XTS-AES-128 par défaut
	}
	return &BitLockerState{
		Volume:           "/",
		Enabled:          enabled,
		ProtectionStatus: state,
		EncryptionMethod: method,
	}
}

// ── XProtect (signatures macOS) ───────────────────────────────────────────
// XProtect est silencieux — pas d'API publique. On expose la date du dernier
// update du bundle XProtect comme proxy "signature_last_update".
//
// Path canonique : /Library/Apple/System/Library/CoreServices/XProtect.bundle
// (depuis macOS 11). Avant : /System/Library/CoreServices/XProtect.bundle.
func collectXProtect() *DefenderState {
	out := &DefenderState{
		AntivirusEnabled:   true, // XProtect tourne par défaut
		RealTimeProtection: true, // scan à l'exécution depuis macOS 14
		AntispywareEnabled: true,
	}
	candidates := []string{
		"/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.plist",
		"/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.plist",
	}
	for _, p := range candidates {
		out2 := runCmd(2*time.Second, "stat", "-f", "%Sm", "-t", "%Y-%m-%d", p)
		out2 = strings.TrimSpace(out2)
		if out2 != "" {
			out.SignatureLastUpdate = &out2
			if t, err := time.Parse("2006-01-02", out2); err == nil {
				age := int(time.Since(t).Hours() / 24)
				out.SignatureAgeDays = &age
			}
			break
		}
	}
	return out
}

// ── Firewall (Application Layer Firewall) ─────────────────────────────────
// `defaults read /Library/Preferences/com.apple.alf globalstate` :
//   0 = off
//   1 = on, allow signed apps + manual
//   2 = on, block all incoming (sauf services système essentiels)
func collectFirewallDarwin() *FirewallState {
	out := strings.TrimSpace(runCmd(2*time.Second, "defaults", "read",
		"/Library/Preferences/com.apple.alf", "globalstate"))
	if out == "" {
		return nil
	}
	state, err := strconv.Atoi(out)
	if err != nil {
		return nil
	}
	enabled := state >= 1
	return &FirewallState{
		DomainEnabled:  enabled,
		PrivateEnabled: enabled,
		PublicEnabled:  enabled,
	}
}

// ── Secure Enclave (proxy TPM) ────────────────────────────────────────────
// Tous les Mac depuis 2018 (T2) + 100% des Apple Silicon ont une Secure
// Enclave. On infère depuis la présence du chipset T2 ou de l'arch arm64.
//
// Heuristique simple : `system_profiler SPiBridgeDataType` donne "Apple T2"
// si présent. Sur Apple Silicon, c'est intégré (toujours présent).
func collectSecureEnclave() *bool {
	if sysctlString("hw.optional.arm64") == "1" {
		t := true
		return &t
	}
	out := runCmd(5*time.Second, "system_profiler", "SPiBridgeDataType")
	present := strings.Contains(out, "Apple T2") || strings.Contains(out, "Apple T1")
	return &present
}

// ── Pending reboot ────────────────────────────────────────────────────────
// `softwareupdate --list` mentionne "restart" dans le label si reboot requis.
// Format ligne :
//   * Label: macOS Sonoma 14.6.1
//      Title: macOS Sonoma 14.6.1, Version: 14.6.1, Size: 6394740K, Recommended: YES, Action: restart
var swUpdateRestartRe = regexp.MustCompile(`(?i)Action:\s*restart`)

func collectPendingRebootDarwin() *bool {
	out := runCmd(15*time.Second, "softwareupdate", "--list")
	if swUpdateRestartRe.MatchString(out) {
		t := true
		return &t
	}
	f := false
	return &f
}

// ── Dernier update système ────────────────────────────────────────────────
// `softwareupdate --history` :
//   Display Name                                    Version    Date
//   ------------                                    -------    ----
//   macOS 14.6.1                                    14.6.1     2025-11-12
//
// On prend la date la plus récente (dernière ligne non-header).
var swHistoryDateRe = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})`)

func collectLastUpdateDarwin() *string {
	out := runCmd(10*time.Second, "softwareupdate", "--history")
	if out == "" {
		return nil
	}
	matches := swHistoryDateRe.FindAllString(out, -1)
	if len(matches) == 0 {
		return nil
	}
	// Tri lexicographique = chronologique (format ISO 8601).
	last := matches[0]
	for _, d := range matches {
		if d > last {
			last = d
		}
	}
	return &last
}
