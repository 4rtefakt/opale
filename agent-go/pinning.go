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
// Match si AU MOINS un cert d'une chaîne VÉRIFIÉE (feuille → racine de
// confiance, construite par crypto/x509) a un SubjectPublicKeyInfo dont le
// SHA-256 figure dans pinSet. Permet de pinner la feuille ET/OU
// l'intermédiaire / la racine — utile pour les rotations LE.
//
// On ignore volontairement rawCerts : c'est la liste brute envoyée par le
// serveur, qui peut contenir des certificats supplémentaires sans rapport
// avec la chaîne validée. Un attaquant muni d'un cert valide (CA publique)
// pourrait y ajouter le cert public du vrai serveur pour satisfaire le pin.
//
// Pas de ClientSessionCache sur nos tls.Config : pas de reprise de session,
// donc ce hook est appelé à chaque handshake.
func verifyPeerSPKI(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
	return matchSPKIPins(pinSet, verifiedChains)
}

// matchSPKIPins — cœur de verifyPeerSPKI, pins injectables pour les tests.
func matchSPKIPins(pins map[string]struct{}, verifiedChains [][]*x509.Certificate) error {
	if len(pins) == 0 {
		return nil // pinning désactivé
	}
	if len(verifiedChains) == 0 {
		// Ne devrait jamais arriver sans InsecureSkipVerify : fail closed.
		return errors.New("pinning SPKI : aucune chaîne vérifiée par la validation CA")
	}
	for _, chain := range verifiedChains {
		for _, cert := range chain {
			if cert == nil {
				continue
			}
			sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
			if _, ok := pins[hex.EncodeToString(sum[:])]; ok {
				return nil
			}
		}
	}
	return errors.New("aucun cert des chaînes vérifiées ne match un SPKI pinné")
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
