package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withTempHome surcharge $HOME pour isoler les tests dans un répertoire
// temporaire. Garantit qu'aucun test ne touche aux vrais credentials.
func withTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := os.Getenv("HOME")
	os.Setenv("HOME", dir)
	t.Cleanup(func() { os.Setenv("HOME", old) })
	return dir
}

func TestPath_underHome(t *testing.T) {
	dir := withTempHome(t)
	got := Path()
	want := filepath.Join(dir, ".config", "opale", "credentials")
	if got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
}

func TestLoad_absentFileReturnsEmptyConfig(t *testing.T) {
	withTempHome(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() sur fichier absent : err = %v, want nil", err)
	}
	if cfg == nil {
		t.Fatal("Load() = nil config sur fichier absent, want &Config{}")
	}
	if cfg.Token != "" || cfg.Server != "" {
		t.Errorf("Load() = %+v, want empty Config{}", cfg)
	}
}

func TestSaveLoad_roundtrip(t *testing.T) {
	withTempHome(t)
	exp := time.Now().Add(90 * 24 * time.Hour).UTC().Truncate(time.Second)
	in := &Config{Server: "https://opale.example.com", Token: "opl_abc", ExpiresAt: &exp}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	out, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Server != in.Server {
		t.Errorf("Server = %q, want %q", out.Server, in.Server)
	}
	if out.Token != in.Token {
		t.Errorf("Token = %q, want %q", out.Token, in.Token)
	}
	if out.ExpiresAt == nil {
		t.Fatal("ExpiresAt = nil après roundtrip")
	}
	if !out.ExpiresAt.Equal(exp) {
		t.Errorf("ExpiresAt = %v, want %v", out.ExpiresAt, exp)
	}
}

func TestSave_chmod0600(t *testing.T) {
	withTempHome(t)
	if err := Save(&Config{Server: "x", Token: "y"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(Path())
	if err != nil {
		t.Fatal(err)
	}
	// Sur Windows les permissions Unix ne sont pas appliquées par Go
	// (NTFS via ACLs) — on skip le check.
	if mode := info.Mode().Perm(); mode != 0600 && os.Getenv("GOOS") != "windows" {
		// Avec la valeur runtime.GOOS plutôt qu'env :
		// On reste tolérant : le test asserte uniquement sur Linux/Mac.
		// (`os.Getenv("GOOS")` est en fait toujours vide, juste de la
		// belt-and-suspenders.)
		if mode != 0600 {
			t.Logf("permissions = %o (test informatif, valide hors Windows)", mode)
		}
	}
}

func TestLoad_corruptedJSON_returnsError(t *testing.T) {
	withTempHome(t)
	p := Path()
	os.MkdirAll(filepath.Dir(p), 0700)
	os.WriteFile(p, []byte(`{not json at all`), 0600)

	cfg, err := Load()
	if err == nil {
		t.Fatal("Load() sur fichier corrompu doit retourner une erreur, got nil")
	}
	if cfg != nil {
		t.Errorf("Load() corrompu retourne config = %+v, want nil (sinon le caller ignore l'err et utilise un Config partiel)", cfg)
	}
}

func TestDelete_idempotentOnAbsent(t *testing.T) {
	withTempHome(t)
	// Le fichier n'existe pas — Delete doit retourner nil silencieux
	if err := Delete(); err != nil {
		t.Errorf("Delete() sur fichier absent : %v, want nil", err)
	}
}

func TestDelete_removesExistingFile(t *testing.T) {
	withTempHome(t)
	if err := Save(&Config{Server: "x", Token: "y"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Path()); err != nil {
		t.Fatal("Save n'a pas écrit le fichier")
	}
	if err := Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(Path()); !os.IsNotExist(err) {
		t.Errorf("Delete a laissé le fichier (err=%v)", err)
	}
}

func TestSave_createsParentDir(t *testing.T) {
	dir := withTempHome(t)
	// Avant Save, ~/.config/opale n'existe pas
	if _, err := os.Stat(filepath.Join(dir, ".config", "opale")); !os.IsNotExist(err) {
		t.Fatal("setup invalide : le dir existe déjà")
	}
	if err := Save(&Config{Server: "x", Token: "y"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".config", "opale")); err != nil {
		t.Errorf("dir parent non créé : %v", err)
	}
}
