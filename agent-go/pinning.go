package main

import (
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
)

//go:embed pinning/pins.txt
var pinsRaw []byte

// pinSet — ensemble des SPKI SHA-256 attendus (hex lowercase). Si vide,
// le pinning est désactivé et seule la validation CA standard s'applique.
// Construit une fois au boot, immutable ensuite.
var pinSet map[string]struct{}

func init() {
	pinSet = parsePinsFile(pinsRaw)
}

func parsePinsFile(raw []byte) map[string]struct{} {
	out := make(map[string]struct{})
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) != 64 {
			continue // SHA-256 hex = 32 bytes = 64 chars
		}
		if _, err := hex.DecodeString(line); err != nil {
			continue
		}
		out[strings.ToLower(line)] = struct{}{}
	}
	return out
}

// verifyPeerSPKI — VerifyPeerCertificate hook : appelé par le client TLS
// APRÈS la validation CA standard (l'host check inclus). Aucun
// InsecureSkipVerify nulle part : on AJOUTE une couche de vérif, on n'en
// remplace aucune.
//
// Match si AU MOINS un cert de la chaîne a un SubjectPublicKeyInfo dont
// le SHA-256 figure dans pinSet. Permet de pinner la feuille ET/OU
// l'intermédiaire — utile pour les rotations LE.
func verifyPeerSPKI(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	if len(pinSet) == 0 {
		return nil // pinning désactivé
	}
	for _, raw := range rawCerts {
		cert, err := x509.ParseCertificate(raw)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
		hexStr := hex.EncodeToString(sum[:])
		if _, ok := pinSet[strings.ToLower(hexStr)]; ok {
			return nil
		}
	}
	return errors.New("aucun cert de la chaîne ne match un SPKI pinné")
}

// PinsList — utilisé par --show-pins. Retourne les pins triés.
func PinsList() []string {
	out := make([]string, 0, len(pinSet))
	for p := range pinSet {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
