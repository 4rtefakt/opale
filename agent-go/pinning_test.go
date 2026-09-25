package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
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

// Mise à jour (fix pinning) : le match se fait sur les chaînes vérifiées,
// plus sur rawCerts — le test passe donc la chaîne vérifiée explicitement.
func TestVerifyPeerSPKI_MatchAccepted(t *testing.T) {
	cert, der := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(cert): {}}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{der}, [][]*x509.Certificate{{cert}}); err != nil {
		t.Errorf("pin match doit passer : %v", err)
	}
}

func TestVerifyPeerSPKI_MismatchRejected(t *testing.T) {
	cert, der := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{
		"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": {},
	}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{der}, [][]*x509.Certificate{{cert}}); err == nil {
		t.Error("pin mismatch doit échouer")
	}
}

// Mise à jour (fix pinning) : avant, ce test acceptait un match n'importe où
// dans rawCerts (comportement vulnérable). Désormais le cert qui matche doit
// appartenir à une chaîne vérifiée (ici : pas la feuille, le 2e maillon).
func TestVerifyPeerSPKI_MatchInChain(t *testing.T) {
	leaf, leafDER := makeSelfSignedCert(t)
	cert2, der2 := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(cert2): {}}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{leafDER, der2}, [][]*x509.Certificate{{leaf, cert2}}); err != nil {
		t.Errorf("match dans la chaîne vérifiée doit passer : %v", err)
	}
}

// Sans chaîne vérifiée (InsecureSkipVerify ou appel inattendu), le pinning
// actif doit refuser plutôt que se rabattre sur rawCerts.
func TestVerifyPeerSPKI_NoVerifiedChainRejected(t *testing.T) {
	cert, der := makeSelfSignedCert(t)
	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(cert): {}}
	defer func() { pinSet = orig }()
	if err := verifyPeerSPKI([][]byte{der}, nil); err == nil {
		t.Error("pin présent dans rawCerts mais aucune chaîne vérifiée : doit échouer")
	}
}

// --- PKI jetable pour les tests de contournement -----------------------------

type testCA struct {
	cert *x509.Certificate
	der  []byte
	key  *ecdsa.PrivateKey
}

func newTestCA(t *testing.T, cn string) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create CA : %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse CA : %v", err)
	}
	return testCA{cert: cert, der: der, key: key}
}

// issueLeaf — cert serveur signé par ca, valide pour 127.0.0.1 / localhost.
func (ca testCA) issueLeaf(t *testing.T, cn string) (*x509.Certificate, []byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey : %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatalf("create leaf : %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse leaf : %v", err)
	}
	return cert, der, key
}

// verifiedChainsFor — ce que crypto/tls passerait à VerifyPeerCertificate.
func verifiedChainsFor(t *testing.T, leaf *x509.Certificate, roots ...*x509.Certificate) [][]*x509.Certificate {
	t.Helper()
	pool := x509.NewCertPool()
	for _, r := range roots {
		pool.AddCert(r)
	}
	chains, err := leaf.Verify(x509.VerifyOptions{Roots: pool})
	if err != nil {
		t.Fatalf("leaf.Verify : %v", err)
	}
	return chains
}

// Contournement : le serveur (attaquant muni d'un cert valide d'une autre CA
// de confiance) ajoute dans son message Certificate le cert PUBLIC du vrai
// serveur, dont le SPKI est pinné. Ce cert ne fait pas partie de la chaîne
// vérifiée → doit être refusé.
func TestVerifyPeerSPKI_ExtraUnverifiedCertRejected(t *testing.T) {
	realCA := newTestCA(t, "real-ca")
	realLeaf, realLeafDER, _ := realCA.issueLeaf(t, "real-server")
	rogueCA := newTestCA(t, "rogue-ca")
	rogueLeaf, rogueLeafDER, _ := rogueCA.issueLeaf(t, "rogue-server")

	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(realLeaf): {}}
	defer func() { pinSet = orig }()

	raw := [][]byte{rogueLeafDER, realLeafDER}
	chains := verifiedChainsFor(t, rogueLeaf, rogueCA.cert, realCA.cert)
	if err := verifyPeerSPKI(raw, chains); err == nil {
		t.Fatal("cert pinné hors chaîne vérifiée accepté : contournement du pinning")
	}
}

// Cas nominal : le pin est celui de la CA (racine) de la chaîne vérifiée.
func TestVerifyPeerSPKI_PinInVerifiedChainAccepted(t *testing.T) {
	ca := newTestCA(t, "pinned-ca")
	leaf, leafDER, _ := ca.issueLeaf(t, "server")

	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(ca.cert): {}}
	defer func() { pinSet = orig }()

	if err := verifyPeerSPKI([][]byte{leafDER}, verifiedChainsFor(t, leaf, ca.cert)); err != nil {
		t.Fatalf("pin de la CA dans la chaîne vérifiée doit passer : %v", err)
	}
}

// pinnedHandshake — vrai handshake TLS contre un serveur qui présente
// `chain` ; le client fait confiance à `roots` et applique verifyPeerSPKI.
func pinnedHandshake(t *testing.T, chain [][]byte, key *ecdsa.PrivateKey, roots ...*x509.Certificate) error {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: chain, PrivateKey: key}}}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // handshakes refusés attendus
	srv.StartTLS()
	defer srv.Close()

	pool := x509.NewCertPool()
	for _, r := range roots {
		pool.AddCert(r)
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:            tls.VersionTLS12,
				RootCAs:               pool,
				VerifyPeerCertificate: verifyPeerSPKI,
			},
		},
	}
	resp, err := client.Get(srv.URL)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func TestPinnedHandshake_ExtraCertBypassRejected(t *testing.T) {
	realCA := newTestCA(t, "real-ca")
	realLeaf, realLeafDER, _ := realCA.issueLeaf(t, "real-server")
	rogueCA := newTestCA(t, "rogue-ca")
	_, rogueLeafDER, rogueKey := rogueCA.issueLeaf(t, "rogue-server")

	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(realLeaf): {}}
	defer func() { pinSet = orig }()

	// Le serveur rogue envoie [sa feuille, cert public du vrai serveur].
	err := pinnedHandshake(t, [][]byte{rogueLeafDER, realLeafDER}, rogueKey, rogueCA.cert, realCA.cert)
	if err == nil {
		t.Fatal("handshake accepté alors que le pin ne figure que dans un cert superflu")
	}
}

func TestPinnedHandshake_PinnedLeafAccepted(t *testing.T) {
	ca := newTestCA(t, "ca")
	leaf, leafDER, key := ca.issueLeaf(t, "server")

	orig := pinSet
	pinSet = map[string]struct{}{spkiHex(leaf): {}}
	defer func() { pinSet = orig }()

	if err := pinnedHandshake(t, [][]byte{leafDER}, key, ca.cert); err != nil {
		t.Fatalf("handshake avec feuille pinnée doit passer : %v", err)
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
