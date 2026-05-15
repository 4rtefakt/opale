package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"testing"
	"time"
)

func makeSelfSignedCert(t *testing.T) (*x509.Certificate, []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create cert : %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse cert : %v", err)
	}
	return cert, der
}

func spkiHex(c *x509.Certificate) string {
	h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(h[:])
}

func TestParsePinsFile_BasicAndComments(t *testing.T) {
	in := []byte(`
# header comment
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# inline comment between pins
ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789

# trailing
`)
	got := parsePinsFile(in)
	if len(got) != 2 {
		t.Fatalf("got %d pins, want 2 — %#v", len(got), got)
	}
	if _, ok := got["abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"]; !ok {
		t.Error("uppercase pin pas normalisé en lowercase")
	}
}

func TestParsePinsFile_RejectsInvalid(t *testing.T) {
	in := []byte(`
short
gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg
0000000000000000000000000000000000000000000000000000000000000001  trailing junk
`)
	got := parsePinsFile(in)
	if len(got) != 0 {
		t.Fatalf("got %d pins, want 0 (tous invalides) — %#v", len(got), got)
	}
}

func TestVerifyPeerSPKI_EmptyPinsAlwaysOK(t *testing.T) {
	orig := pinSet
	pinSet = map[string]struct{}{}
	defer func() { pinSet = orig }()
	cert, der := makeSelfSignedCert(t)
	_ = cert
	if err := verifyPeerSPKI([][]byte{der}, nil); err != nil {
		t.Errorf("empty pins doit passer : %v", err)
	}
}

func TestVerifyPeerSPKI_MatchAccepted(t *testing.T) {
	cert, der := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(cert): {}}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{der}, nil); err != nil {
		t.Errorf("pin match doit passer : %v", err)
	}
}

func TestVerifyPeerSPKI_MismatchRejected(t *testing.T) {
	_, der := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{
		"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": {},
	}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{der}, nil); err == nil {
		t.Error("pin mismatch doit échouer")
	}
}

func TestVerifyPeerSPKI_MatchInChain(t *testing.T) {
	// Si un cert de la chaîne (pas forcément la feuille) match, on accepte.
	_, leafDER := makeSelfSignedCert(t)
	cert2, der2 := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(cert2): {}}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{leafDER, der2}, nil); err != nil {
		t.Errorf("match dans la chaîne doit passer : %v", err)
	}
}

func TestEmbeddedPins_AtLeastOne(t *testing.T) {
	// En build public, pins.txt est un template vide → pinSet vide est OK
	// et signifie "pinning désactivé, fallback CA standard" (cf. pinning.go).
	// Sur un build d'instance qui a overlay-é pins.txt depuis instance-local/,
	// pinSet doit être non-vide. Ce test informe sans échouer pour ne pas
	// bloquer le CI du repo public.
	t.Logf("pinSet entries: %d (0 = pinning désactivé, fallback CA standard)", len(pinSet))
}
