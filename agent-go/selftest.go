package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// Self-test : valide que le runtime de l'agent est sain. Sortie lisible
// + exit code 0/1 pour scripts d'admin. Sûr à lancer même si le service
// est dans un état douteux : aucune écriture en dehors du fichier .selftest
// dans le data dir.

type testResult struct {
	Name    string
	OK      bool
	Message string
}

// RunSelfTest exécute la batterie de tests et retourne l'exit code.
func RunSelfTest() int {
	fmt.Println(branding.BinName, "self-test —", AgentVersion)
	fmt.Println("---")

	tests := []func() testResult{
		testEmbeddedPubKey,
		testEmbeddedPins,
		testDataDirExists,
		testDataDirWritable,
		testConfigReadable,
		testStateReadable,
		testServerReachable,
	}
	tests = append(tests, platformSelfTests()...)

	failed := 0
	for _, t := range tests {
		r := t()
		mark := "✓"
		if !r.OK {
			mark = "✗"
			failed++
		}
		fmt.Printf("  %s %-32s %s\n", mark, r.Name, r.Message)
	}

	fmt.Println("---")
	if failed > 0 {
		fmt.Printf("%d test(s) en échec\n", failed)
		return 1
	}
	fmt.Println("Tous les tests OK")
	return 0
}

func testEmbeddedPubKey() testResult {
	// init() a déjà parsé pubKey ou crashé. Si on arrive ici, c'est OK.
	return testResult{Name: "Clé publique embarquée", OK: true,
		Message: fmt.Sprintf("ed25519 (%d bits)", len(pubKey)*8)}
}

func testEmbeddedPins() testResult {
	pins := PinsList()
	if len(pins) == 0 {
		return testResult{Name: "Pinning TLS", OK: true, Message: "désactivé (aucun pin embarqué)"}
	}
	short := make([]string, len(pins))
	for i, p := range pins {
		short[i] = p[:12] + "…"
	}
	return testResult{Name: "Pinning TLS", OK: true,
		Message: fmt.Sprintf("%d pin(s) : %v", len(pins), short)}
}

func testDataDirExists() testResult {
	d := dataDir()
	st, err := os.Stat(d)
	if err != nil {
		return testResult{Name: "Data dir existe", Message: fmt.Sprintf("%s : %v", d, err)}
	}
	if !st.IsDir() {
		return testResult{Name: "Data dir existe", Message: d + " : pas un dossier"}
	}
	return testResult{Name: "Data dir existe", OK: true, Message: d}
}

func testDataDirWritable() testResult {
	probe := filepath.Join(dataDir(), ".selftest")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return testResult{Name: "Data dir writable", Message: err.Error()}
	}
	defer os.Remove(probe)
	return testResult{Name: "Data dir writable", OK: true, Message: probe}
}

func testConfigReadable() testResult {
	cfg, err := LoadConfig()
	if err != nil {
		return testResult{Name: "Config valide", Message: err.Error()}
	}
	// On masque le token (premier+dernier 4 caractères seulement).
	masked := "(vide)"
	if n := len(cfg.Token); n >= 8 {
		masked = cfg.Token[:4] + "…" + cfg.Token[n-4:]
	}
	return testResult{Name: "Config valide", OK: true,
		Message: fmt.Sprintf("url=%s token=%s", cfg.URL, masked)}
}

func testStateReadable() testResult {
	st := LoadState()
	pending := len(st.PendingDeployments) + len(st.PendingDetections)
	msg := fmt.Sprintf("%d résultat(s) en attente", pending)
	if !st.LastUpdateAt.IsZero() {
		msg += fmt.Sprintf(", update %s en surveillance (failed=%d)",
			st.LastUpdateVersion, st.FailedSinceUpdate)
	}
	return testResult{Name: "State lisible", OK: true, Message: msg}
}

func testServerReachable() testResult {
	cfg, err := LoadConfig()
	if err != nil {
		return testResult{Name: "Serveur accessible", Message: "config absente"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.URL+"/api/agent/version", nil)
	if err != nil {
		return testResult{Name: "Serveur accessible", Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("User-Agent", userAgent()+" selftest")

	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:            tls.VersionTLS12,
				VerifyPeerCertificate: verifyPeerSPKI,
			},
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return testResult{Name: "Serveur accessible", Message: err.Error()}
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		return testResult{Name: "Serveur accessible", OK: true,
			Message: fmt.Sprintf("HTTP 200 (TLS %s)", tlsVersion(resp.TLS))}
	case 401, 403:
		return testResult{Name: "Serveur accessible",
			Message: fmt.Sprintf("HTTP %d — token rejeté ou révoqué", resp.StatusCode)}
	default:
		return testResult{Name: "Serveur accessible",
			Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
}

func tlsVersion(s *tls.ConnectionState) string {
	if s == nil {
		return "?"
	}
	switch s.Version {
	case tls.VersionTLS13:
		return "1.3"
	case tls.VersionTLS12:
		return "1.2"
	}
	return fmt.Sprintf("0x%x", s.Version)
}

// runtimeOSLine — utilisé dans les tests platform pour tagger l'OS.
func runtimeOSLine() string {
	return fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH)
}
