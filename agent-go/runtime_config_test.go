package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// newRuntimeConfigServer monte un httptest qui retourne le body fourni avec
// le statut donné. Renvoie l'URL base et un compteur atomique du nombre de
// hits — utile pour vérifier le respect du cache TTL.
func newRuntimeConfigServer(t *testing.T, status int, body string) (string, *int64) {
	t.Helper()
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/runtime-config" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer testtoken" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &hits
}

func TestRuntimeConfig_FetchSuccess(t *testing.T) {
	resetRuntimeConfigCacheForTest()
	t.Cleanup(resetRuntimeConfigCacheForTest)

	url, hits := newRuntimeConfigServer(t, 200, `{"laps_recovery_username":"custom-recovery"}`)

	rc := GetRuntimeConfig(http.DefaultClient, url, "testtoken")
	if rc.LAPSRecoveryUsername != "custom-recovery" {
		t.Fatalf("got %q, want %q", rc.LAPSRecoveryUsername, "custom-recovery")
	}
	if got := atomic.LoadInt64(hits); got != 1 {
		t.Fatalf("hits = %d, want 1 (un seul fetch attendu)", got)
	}
}

func TestRuntimeConfig_FallbackOnNetworkError(t *testing.T) {
	resetRuntimeConfigCacheForTest()
	t.Cleanup(resetRuntimeConfigCacheForTest)

	// Démarre puis ferme le serveur immédiatement → la connexion échoue.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close()

	rc := GetRuntimeConfig(http.DefaultClient, srv.URL, "testtoken")
	if rc.LAPSRecoveryUsername != "" {
		t.Fatalf("got %q, want zero value (network error → fallback)", rc.LAPSRecoveryUsername)
	}
}

func TestRuntimeConfig_FallbackOnInvalidJSON(t *testing.T) {
	resetRuntimeConfigCacheForTest()
	t.Cleanup(resetRuntimeConfigCacheForTest)

	url, _ := newRuntimeConfigServer(t, 200, `not valid json {{{`)

	rc := GetRuntimeConfig(http.DefaultClient, url, "testtoken")
	if rc.LAPSRecoveryUsername != "" {
		t.Fatalf("got %q, want zero value (invalid JSON → fallback)", rc.LAPSRecoveryUsername)
	}
	// Cache ne doit pas avoir été poisoned : un nouvel appel doit refetch.
	runtimeCfgMu.RLock()
	defer runtimeCfgMu.RUnlock()
	if !runtimeCfgFetchAt.IsZero() {
		t.Fatalf("fetchAt non zéro après échec parse — le cache a été poisoned")
	}
}

func TestRuntimeConfig_CacheRespectsTTL(t *testing.T) {
	resetRuntimeConfigCacheForTest()
	t.Cleanup(resetRuntimeConfigCacheForTest)

	url, hits := newRuntimeConfigServer(t, 200, `{"laps_recovery_username":"cached-recovery"}`)

	// Premier appel : doit fetcher.
	_ = GetRuntimeConfig(http.DefaultClient, url, "testtoken")
	if got := atomic.LoadInt64(hits); got != 1 {
		t.Fatalf("hits après 1er appel = %d, want 1", got)
	}

	// Deuxième appel immédiat : doit servir depuis le cache, pas de hit réseau.
	_ = GetRuntimeConfig(http.DefaultClient, url, "testtoken")
	if got := atomic.LoadInt64(hits); got != 1 {
		t.Fatalf("hits après 2e appel = %d, want 1 (cache TTL)", got)
	}

	// Force l'expiration en remontant fetchAt au-delà du TTL.
	runtimeCfgMu.Lock()
	runtimeCfgFetchAt = time.Now().Add(-2 * RuntimeConfigTTL)
	runtimeCfgMu.Unlock()

	// Troisième appel : cache expiré → re-fetch.
	_ = GetRuntimeConfig(http.DefaultClient, url, "testtoken")
	if got := atomic.LoadInt64(hits); got != 2 {
		t.Fatalf("hits après expiration = %d, want 2 (re-fetch attendu)", got)
	}
}

func TestResolveLAPSUser_BuildtimeFallbackWhenServerEmpty(t *testing.T) {
	resetRuntimeConfigCacheForTest()
	t.Cleanup(resetRuntimeConfigCacheForTest)

	// Pré-remplit le cache avec une réponse "serveur OK mais champ vide" :
	// fetchAt frais → ResolveLAPSUser ne refetchera pas, et tombera dans
	// la cascade pour finir sur branding.LAPSDefaultUser.
	runtimeCfgMu.Lock()
	runtimeCfgCache = RuntimeConfig{LAPSRecoveryUsername: ""}
	runtimeCfgFetchAt = time.Now()
	runtimeCfgMu.Unlock()

	cfg := &Config{URL: "https://unused.example", Token: "unused"}
	got := ResolveLAPSUser(cfg)
	if got != branding.LAPSDefaultUser {
		t.Fatalf("got %q, want branding.LAPSDefaultUser %q", got, branding.LAPSDefaultUser)
	}

	// Avec un cfg.LAPSUser explicite, c'est ce dernier qui doit gagner
	// avant le build-time (préservation backward-compat).
	cfg.LAPSUser = "explicit-from-config"
	if got := ResolveLAPSUser(cfg); got != "explicit-from-config" {
		t.Fatalf("got %q, want %q (cfg.LAPSUser override le build-time)", got, "explicit-from-config")
	}
}
