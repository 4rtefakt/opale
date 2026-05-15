package cmd

import (
	"encoding/base64"
	"regexp"
	"testing"
)

func TestPkceChallenge_verifierEntropyAndChallengeHash(t *testing.T) {
	v1, c1, err := pkceChallenge()
	if err != nil {
		t.Fatal(err)
	}
	v2, c2, err := pkceChallenge()
	if err != nil {
		t.Fatal(err)
	}
	// Unicité (2 appels successifs doivent diverger)
	if v1 == v2 {
		t.Error("verifier identique sur 2 appels — entropie insuffisante")
	}
	if c1 == c2 {
		t.Error("challenge identique sur 2 appels — entropie insuffisante")
	}

	// Format base64-url sans padding
	urlRe := regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	if !urlRe.MatchString(v1) {
		t.Errorf("verifier %q n'est pas du base64url valide", v1)
	}
	if !urlRe.MatchString(c1) {
		t.Errorf("challenge %q n'est pas du base64url valide", c1)
	}

	// RFC 7636 §4.1 : verifier 43-128 chars (32 bytes → 43 chars en base64url RawURLEncoding)
	if len(v1) < 43 || len(v1) > 128 {
		t.Errorf("longueur verifier = %d, attendu 43-128", len(v1))
	}

	// Challenge = SHA-256 du verifier, encodé base64url RawURLEncoding
	// (43 chars de 256 bits)
	if len(c1) != 43 {
		t.Errorf("longueur challenge = %d, attendu 43 (SHA-256 b64url)", len(c1))
	}

	// Vérifie qu'on peut décoder le challenge (32 bytes = SHA-256)
	dec, err := base64.RawURLEncoding.DecodeString(c1)
	if err != nil {
		t.Errorf("challenge décodage : %v", err)
	}
	if len(dec) != 32 {
		t.Errorf("challenge décodé = %d bytes, attendu 32 (SHA-256)", len(dec))
	}
}

func TestRandomHex_lengthAndCharset(t *testing.T) {
	h := randomHex(16)
	if len(h) != 32 {
		t.Errorf("randomHex(16) = %q, longueur %d, attendu 32", h, len(h))
	}
	re := regexp.MustCompile(`^[0-9a-f]+$`)
	if !re.MatchString(h) {
		t.Errorf("randomHex contient des chars non-hex : %q", h)
	}
}
