package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// La rotation du token (goroutine de checkin) écrit cfg.Token pendant que
// la goroutine WS le lit pour chaque (re)connexion. À lancer avec -race :
// sans synchronisation, le détecteur signale la course et le test échoue.
func TestConfigToken_RotationConcurrentWithWS(t *testing.T) {
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	newTok := strings.Repeat("n", 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/rotate-token" {
			_ = json.NewEncoder(w).Encode(map[string]string{"token": newTok})
			return
		}
		// Upgrade WS refusé : runWSSession ressort vite, après avoir lu le token.
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	cfg := &Config{Token: strings.Repeat("o", 64), URL: srv.URL}
	st := &State{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			_ = runWSSession(ctx, cfg)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			st.LastTokenRotation = time.Now().Add(-2 * TokenRotationInterval)
			MaybeRotateToken(ctx, cfg, st)
		}
	}()
	wg.Wait()

	if got := cfg.token(); got != newTok {
		t.Fatalf("token après rotation = %q, attendu %q", got, newTok)
	}
}
