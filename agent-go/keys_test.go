package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// genTestKey génère une keypair ed25519 et retourne le PEM de la clé publique
// + la clé privée brute. Utilisé pour tester la chaîne parse + verify sans
// dépendre de la vraie clé du dépôt.
func genTestKey(t *testing.T) ([]byte, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return pemBytes, priv
}

func TestParseEd25519PubKey_OK(t *testing.T) {
	pemBytes, _ := genTestKey(t)
	pk, err := parseEd25519PubKey(pemBytes)
	if err != nil {
		t.Fatalf("parseEd25519PubKey: %v", err)
	}
	if len(pk) != ed25519.PublicKeySize {
		t.Fatalf("taille clé: %d", len(pk))
	}
}

func TestParseEd25519PubKey_BadPEM(t *testing.T) {
	cases := [][]byte{
		nil,
		[]byte(""),
		[]byte("pas du PEM"),
		[]byte("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"),
	}
	for i, c := range cases {
		if _, err := parseEd25519PubKey(c); err == nil {
			t.Errorf("cas %d : pas d'erreur sur entrée invalide", i)
		}
	}
}

func TestParseEd25519PubKey_RSAReject(t *testing.T) {
	// Clé RSA en PEM PKIX — doit être rejetée car non-ed25519.
	rsaPEM := []byte(`-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvwPXkN3FRLn3i6XWLJep
WpcqUPFCDQUjbEIgnRoTU0n6KOpDTHFPsjAtKRZJ2cm5wgEgEZ34GZpMSqPOLwuk
fQVx1Twf/IfgRNJG4AQrG6/0sPWP6tJxaWWRb0DUcqNK6lNGo+fGHGz0ZuKQRbFX
WcuBkMZTbDhwNBbBFh6yp1Q5n/Z+RcaB2zlXwXJa7v2mVFZCrTUk2PaTBiLJjxFY
xHnhQy0HiR8yPbwlWZS6S6chU8lkyP4f73HJ87a9LQH6q5g6q7MjT7NZsxeZv8Lj
lhLZklP/4wKMZqL2mYR+HhwoEwfRY+RKv96PEmJPABgIugGl0c1NOKHaRkPF7ANB
WwIDAQAB
-----END PUBLIC KEY-----`)
	if _, err := parseEd25519PubKey(rsaPEM); err == nil {
		t.Fatal("clé RSA acceptée à tort")
	}
}

// makeVerifier — installe une clé de test dans pubKey global et retourne
// un cleanup. Permet de tester VerifyBinarySignature sans toucher à la
// vraie clé embarquée.
func makeVerifier(t *testing.T) (sign func([]byte) []byte, cleanup func()) {
	t.Helper()
	pemBytes, priv := genTestKey(t)
	pk, err := parseEd25519PubKey(pemBytes)
	if err != nil {
		t.Fatalf("parseEd25519PubKey: %v", err)
	}
	orig := pubKey
	pubKey = pk
	return func(b []byte) []byte { return ed25519.Sign(priv, b) },
		func() { pubKey = orig }
}

func TestVerifyBinarySignature_OK(t *testing.T) {
	sign, cleanup := makeVerifier(t)
	defer cleanup()
	bin := []byte("binaire fictif")
	sig := sign(bin)
	if err := VerifyBinarySignature(bin, sig); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestVerifyBinarySignature_TamperedBinary(t *testing.T) {
	sign, cleanup := makeVerifier(t)
	defer cleanup()
	bin := []byte("binaire fictif")
	sig := sign(bin)
	tampered := append([]byte{}, bin...)
	tampered[0] ^= 0xff
	if err := VerifyBinarySignature(tampered, sig); err == nil {
		t.Fatal("binaire altéré accepté à tort")
	}
}

func TestVerifyBinarySignature_TamperedSig(t *testing.T) {
	sign, cleanup := makeVerifier(t)
	defer cleanup()
	bin := []byte("binaire fictif")
	sig := sign(bin)
	sig[0] ^= 0xff
	if err := VerifyBinarySignature(bin, sig); err == nil {
		t.Fatal("signature altérée acceptée à tort")
	}
}

func TestVerifyBinarySignature_WrongSize(t *testing.T) {
	if err := VerifyBinarySignature([]byte("x"), []byte("trop court")); err == nil {
		t.Fatal("signature de mauvaise taille acceptée à tort")
	}
}

func TestVerifyBinarySignature_WrongKey(t *testing.T) {
	// Signe avec une clé, vérifie avec celle d'origine (différente).
	_, priv := genTestKey(t)
	bin := []byte("binaire fictif")
	sig := ed25519.Sign(priv, bin)
	if err := VerifyBinarySignature(bin, sig); err == nil {
		t.Fatal("signature d'une autre clé acceptée à tort")
	}
}

func TestEmbeddedPubKey_Loaded(t *testing.T) {
	// La clé embarquée du dépôt doit être parsée correctement par init().
	if pubKey == nil || len(pubKey) != ed25519.PublicKeySize {
		t.Fatal("pubKey embarquée non chargée")
	}
}
