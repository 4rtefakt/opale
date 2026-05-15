package main

import (
	"encoding/base64"
	"os"
	"testing"
)

// TestInterop_NodeSignedBinary vérifie que Go accepte une signature
// ed25519 produite par Node `crypto.sign(null, body, pemKey)`. C'est le
// cas critique : si ce test échoue, le serveur produira des signatures
// que l'agent rejettera, bloquant tout l'auto-update.
//
// Les fichiers /tmp/test-* sont produits par le helper Node de la session
// (cf. README dev). Le test est skipped si absents pour rester portable.
func TestInterop_NodeSignedBinary(t *testing.T) {
	bin, err := os.ReadFile("/tmp/test-bin.bin")
	if err != nil {
		t.Skip("fixture absente : /tmp/test-bin.bin")
	}
	sigB64, err := os.ReadFile("/tmp/test-sig.b64")
	if err != nil {
		t.Skip("fixture absente : /tmp/test-sig.b64")
	}
	sig, err := base64.StdEncoding.DecodeString(string(sigB64))
	if err != nil {
		t.Fatalf("decode sig : %v", err)
	}
	if err := VerifyBinarySignature(bin, sig); err != nil {
		t.Fatalf("Go REJETTE la signature Node : %v", err)
	}
}
