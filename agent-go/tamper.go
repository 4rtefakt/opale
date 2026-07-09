package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// clearTamperBaselineAt efface le baseline anti-tamper (hash du binaire) dans
// le state.json du dataDir fourni. À appeler lors d'une (ré)installation qui
// remplace le binaire : sinon le hash de l'ANCIEN binaire resterait comme
// référence et déclencherait un faux "tamper detected" à chaque checkin. Le
// baseline est ré-établi proprement au prochain démarrage (CheckBinaryIntegrity).
// Best-effort : toute erreur est silencieuse (au pire on garde le faux positif,
// jamais on ne casse l'install).
func clearTamperBaselineAt(dataDir string) {
	p := filepath.Join(dataDir, "state.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return // pas de state (première install) → rien à faire
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		// state corrompu : on le supprime, l'agent le recrée + re-baseline.
		_ = os.Remove(p)
		return
	}
	st.BinarySHA256 = ""
	st.BinaryUpdatedAt = time.Time{}
	out, err := json.Marshal(&st)
	if err != nil {
		return
	}
	_ = os.WriteFile(p, out, 0o600)
}

// computeOwnBinarySHA256 lit le fichier .exe duquel le process a été
// chargé et retourne son SHA-256 hexadécimal (lowercase).
func computeOwnBinarySHA256() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable : %w", err)
	}
	f, err := os.Open(p)
	if err != nil {
		return "", fmt.Errorf("open %s : %w", p, err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("read : %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// runtimeTamper — rapport en mémoire produit au démarrage. Inclus dans
// chaque checkin tant qu'il n'est pas effacé. Le baseline en state n'est
// PAS mis à jour automatiquement sur mismatch — ça fait que le tamper
// "sticke" jusqu'à intervention manuelle (clear de state.BinarySHA256).
var runtimeTamper *TamperReport

// CheckBinaryIntegrity — appelé une fois au boot. Établit le baseline
// au premier lancement, alerte sinon. Le résultat (ou nil) est exposé
// via runtimeTamper et inclus dans les checkins.
func CheckBinaryIntegrity(st *State) {
	current, err := computeOwnBinarySHA256()
	if err != nil {
		logError("tamper-check-fail", err, nil)
		return
	}

	if st.BinarySHA256 == "" {
		// Premier lancement (post-install ou state.json effacé).
		// On enregistre le hash actuel comme baseline.
		st.BinarySHA256 = current
		st.BinaryUpdatedAt = time.Now().UTC()
		st.Save()
		logInfo("binary-baseline", "hash baseline enregistré", LogFields{
			"sha256": current,
		})
		return
	}

	if strings.EqualFold(current, st.BinarySHA256) {
		return // OK
	}

	logWarn("tamper-detected", "binaire altéré ou state.json corrompu", LogFields{
		"expected": st.BinarySHA256,
		"actual":   current,
	})
	runtimeTamper = &TamperReport{
		Expected:   st.BinarySHA256,
		Actual:     current,
		DetectedAt: time.Now().UTC().Format(time.RFC3339),
	}
}
