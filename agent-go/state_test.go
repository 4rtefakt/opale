package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// bigState — state volumineux (~1 Mio) pour élargir la fenêtre pendant
// laquelle une écriture non atomique laisse un fichier partiel.
func bigState() *State {
	st := &State{BinarySHA256: strings.Repeat("a", 64)}
	out := strings.Repeat("x", 512)
	for i := 0; i < 2000; i++ {
		st.PendingDeployments = append(st.PendingDeployments, DeploymentResult{
			DeploymentID: "dep", ExitCode: i, Output: out,
		})
	}
	return st
}

// Un lecteur concurrent (ou un crash au milieu de l'écriture) ne doit
// jamais voir un state.json tronqué : soit l'ancienne version, soit la
// nouvelle.
func TestStateSave_ReaderNeverSeesPartialFile(t *testing.T) {
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	st := bigState()
	if err := st.Save(); err != nil {
		t.Fatalf("save initial : %v", err)
	}

	var partial atomic.Int64
	var reads atomic.Int64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			raw, err := os.ReadFile(statePath())
			if err != nil {
				partial.Add(1)
				continue
			}
			reads.Add(1)
			var s State
			if err := json.Unmarshal(raw, &s); err != nil {
				partial.Add(1)
			}
		}
	}()

	deadline := time.Now().Add(1 * time.Second)
	for i := 0; i < 300 && time.Now().Before(deadline); i++ {
		st.FailedSinceUpdate = i
		st.Save()
	}
	close(stop)
	wg.Wait()

	if n := partial.Load(); n > 0 {
		t.Fatalf("%d lecture(s) de state.json partiel/absent sur %d (écriture non atomique)", n, reads.Load()+n)
	}
}

func TestStateSave_NoTempLeftoverAndRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("RMM_DATA_DIR", dir)
	st := &State{LastUpdateVersion: "9.9.9", FailedSinceUpdate: 1}
	if err := st.Save(); err != nil {
		t.Fatalf("save : %v", err)
	}
	got := LoadState()
	if got.LastUpdateVersion != "9.9.9" || got.FailedSinceUpdate != 1 {
		t.Fatalf("round-trip KO : %+v", got)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "state.json" {
			t.Errorf("fichier résiduel inattendu : %s", e.Name())
		}
	}
}

// Échec d'écriture : l'ancien fichier doit rester intact et l'erreur
// remontée à l'appelant (la LAPS en dépend pour ne pas POSTer sans trace).
func TestWriteFileAtomic_FailureKeepsOldContent(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if err := os.WriteFile(p, []byte(`{"old":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Cible impossible : le chemin désigne un dossier inexistant.
	if err := writeFileAtomic(filepath.Join(dir, "absent", "state.json"), []byte("x"), 0o600); err == nil {
		t.Fatal("attendu une erreur pour un dossier inexistant")
	}
	raw, _ := os.ReadFile(p)
	if string(raw) != `{"old":true}` {
		t.Fatalf("contenu modifié : %q", raw)
	}
}

func TestConfigSave_AtomicRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("RMM_DATA_DIR", dir)
	c := &Config{Token: strings.Repeat("t", 64), URL: "https://rmm.example.com"}
	if err := c.Save(); err != nil {
		t.Fatalf("save : %v", err)
	}
	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("load : %v", err)
	}
	if got.Token != c.Token || got.URL != c.URL {
		t.Fatalf("round-trip KO : %+v", got)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "config.json" {
			t.Errorf("fichier résiduel inattendu : %s", e.Name())
		}
	}
}
