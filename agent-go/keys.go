package main

import (
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	_ "embed"
	"encoding/pem"
	"errors"
	"fmt"
)

//go:embed keys/signing.pub
var signingPubPEM []byte

//go:embed keys/laps.pub
var lapsPubPEM []byte

// lapsPubKey — clé publique RSA pour chiffrer le mdp admin local.
// L'agent chiffre, le serveur déchiffre avec laps.key (côté serveur).
var lapsPubKey *rsa.PublicKey

// pubKey — clé publique ed25519 parsée au démarrage. Si le PEM embarqué
// est corrompu, l'agent crash immédiatement (init), ce qui est le bon
// comportement : sans clé valide, on ne peut pas vérifier les updates.
var pubKey ed25519.PublicKey

func init() {
	pk, err := parseEd25519PubKey(signingPubPEM)
	if err != nil {
		panic(fmt.Sprintf("clé publique signing invalide : %v", err))
	}
	pubKey = pk

	rsaKey, err := parseRSAPubKey(lapsPubPEM)
	if err != nil {
		// Non-fatal : si LAPS pas configuré, on n'a pas besoin de chiffrer.
		// Mais on log un warning au démarrage de la rotation si elle est activée.
		lapsPubKey = nil
	} else {
		lapsPubKey = rsaKey
	}
}

func parseRSAPubKey(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("PEM invalide (pas de bloc)")
	}
	if block.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("PEM type inattendu : %q", block.Type)
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX : %w", err)
	}
	pk, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("clé non-RSA : %T", parsed)
	}
	if pk.N.BitLen() < 2048 {
		return nil, fmt.Errorf("clé RSA trop courte : %d bits", pk.N.BitLen())
	}
	return pk, nil
}

func parseEd25519PubKey(pemBytes []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("PEM invalide (pas de bloc)")
	}
	if block.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("PEM type inattendu : %q", block.Type)
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX : %w", err)
	}
	pk, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("clé non-ed25519 : %T", parsed)
	}
	if len(pk) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("taille clé inattendue : %d", len(pk))
	}
	return pk, nil
}

// VerifyBinarySignature retourne nil si la signature est valide pour
// le binaire et la clé publique embarquée. N'importe quelle erreur
// (signature invalide, taille incorrecte, etc.) doit interrompre l'update.
func VerifyBinarySignature(binary, signature []byte) error {
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("signature de taille incorrecte : %d (attendu %d)", len(signature), ed25519.SignatureSize)
	}
	if !ed25519.Verify(pubKey, binary, signature) {
		return errors.New("signature ed25519 invalide")
	}
	return nil
}
