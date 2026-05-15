package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

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
