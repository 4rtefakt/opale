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
// Match si AU MOINS un cert de la CHAÎNE VÉRIFIÉE (feuille → intermédiaires
// → RACINE) a un SubjectPublicKeyInfo dont le SHA-256 figure dans pinSet.
//
// On teste la chaîne VÉRIFIÉE (verifiedChains), pas seulement les certs bruts
// envoyés par le serveur : la racine n'est presque jamais présentée sur le
// fil, mais elle est TOUJOURS dans la chaîne vérifiée (construite via le trust
// store, car InsecureSkipVerify=false). Pinner la RACINE ISRG plutôt que la
// feuille/l'intermédiaire permet de survivre à toutes les rotations LE
// (E5-E9, R10-R14, YE1/Root YE…) sans re-déploiement — cf. incident 07/2026
// où le pin leaf+E7 est mort quand LE a basculé E7→E8/YE1.
func verifyPeerSPKI(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	if len(pinSet) == 0 {
		return nil // pinning désactivé
	}
	for _, chain := range verifiedChains {
		for _, cert := range chain {
			if pinnedSPKI(cert.RawSubjectPublicKeyInfo) {
				return nil
			}
		}
	}
	// Fallback défensif : certs bruts présentés. Ne devrait pas être atteint
	// avec InsecureSkipVerify=false (verifiedChains non vide), mais on couvre
	// le cas où pinSet contiendrait une feuille/intermédiaire présenté.
	for _, raw := range rawCerts {
		cert, err := x509.ParseCertificate(raw)
		if err != nil {
			continue
		}
		if pinnedSPKI(cert.RawSubjectPublicKeyInfo) {
			return nil
		}
	}
	return errors.New("aucun cert de la chaîne vérifiée ne match un SPKI pinné")
}

// pinnedSPKI — true si le SHA-256 du SubjectPublicKeyInfo est dans pinSet.
func pinnedSPKI(spki []byte) bool {
	sum := sha256.Sum256(spki)
	_, ok := pinSet[hex.EncodeToString(sum[:])]
	return ok
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
