package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// RuntimeConfigTTL — fenêtre de validité du cache. 5min : assez court pour
// que les changements UI Paramètres soient pris en compte au cycle suivant
// (checkin = 15min), assez long pour ne pas hammer l'endpoint depuis les
// helpers internes (LAPS, etc.).
const RuntimeConfigTTL = 5 * time.Minute

// runtimeConfigFetchTimeout — coupure stricte côté agent. Si le serveur ne
// répond pas vite, on tombe en fallback sans bloquer le cycle checkin.
const runtimeConfigFetchTimeout = 10 * time.Second

// RuntimeConfig — paramètres servis par GET /api/agent/runtime-config.
// Le serveur peut ajouter des champs ; les inconnus sont ignorés.
type RuntimeConfig struct {
	LAPSRecoveryUsername string `json:"laps_recovery_username"`
}

var (
	runtimeCfgMu      sync.RWMutex
	runtimeCfgCache   RuntimeConfig
	runtimeCfgFetchAt time.Time // dernière mise à jour réussie ; zéro = jamais
)

// GetRuntimeConfig retourne la valeur cachée si elle est dans la fenêtre
// TTL, sinon fait un GET vers /api/agent/runtime-config.
//
// Comportement non bloquant en cas d'échec :
//   - si le cache contient une valeur précédemment fetchée (même si expirée),
//     elle est retournée et un warn est loggé ;
//   - sinon, retourne le zéro value RuntimeConfig{} et le caller décidera
//     du fallback (typiquement la constante build-time).
//
// Reçoit le client HTTP en paramètre pour permettre l'injection en test
// (le client de prod fait du SPKI pinning incompatible avec httptest).
func GetRuntimeConfig(client *http.Client, baseURL, token string) RuntimeConfig {
	runtimeCfgMu.RLock()
	if !runtimeCfgFetchAt.IsZero() && time.Since(runtimeCfgFetchAt) < RuntimeConfigTTL {
		cached := runtimeCfgCache
		runtimeCfgMu.RUnlock()
		return cached
	}
	runtimeCfgMu.RUnlock()

	fresh, err := fetchRuntimeConfig(client, baseURL, token)
	if err != nil {
		runtimeCfgMu.RLock()
		stale := runtimeCfgCache
		hadCache := !runtimeCfgFetchAt.IsZero()
		runtimeCfgMu.RUnlock()
		fields := LogFields{"error": err.Error()}
		if hadCache {
			fields["fallback"] = "stale-cache"
		} else {
			fields["fallback"] = "build-time"
		}
		logWarn("runtime-config-fetch-fail", "fallback runtime-config", fields)
		return stale
	}

	runtimeCfgMu.Lock()
	runtimeCfgCache = fresh
	runtimeCfgFetchAt = time.Now()
	runtimeCfgMu.Unlock()
	return fresh
}

func fetchRuntimeConfig(client *http.Client, baseURL, token string) (RuntimeConfig, error) {
	var zero RuntimeConfig
	if client == nil || baseURL == "" || token == "" {
		return zero, errors.New("client/baseURL/token vide")
	}
	ctx, cancel := context.WithTimeout(context.Background(), runtimeConfigFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/agent/runtime-config", nil)
	if err != nil {
		return zero, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", userAgent())

	resp, err := client.Do(req)
	if err != nil {
		return zero, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return zero, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return zero, err
	}
	var rc RuntimeConfig
	if err := json.Unmarshal(raw, &rc); err != nil {
		return zero, err
	}
	return rc, nil
}

// ResolveLAPSUser retourne le nom du compte LAPS recovery effectif.
//
// Cascade :
//  1. Valeur runtime servie par /api/agent/runtime-config (si non vide).
//  2. cfg.LAPSUser explicitement défini dans config.json (override local
//     historique — préservé pour ne pas régresser les installs existantes).
//  3. branding.LAPSDefaultUser (constante build-time).
//
// Toujours synchrone et borné par RuntimeConfigTTL (cache) +
// runtimeConfigFetchTimeout (réseau) — safe à appeler depuis n'importe
// quel chemin chaud.
func ResolveLAPSUser(cfg *Config) string {
	if cfg != nil && cfg.URL != "" && cfg.Token != "" {
		rc := GetRuntimeConfig(httpClient, cfg.URL, cfg.Token)
		if rc.LAPSRecoveryUsername != "" {
			return rc.LAPSRecoveryUsername
		}
	}
	if cfg != nil && cfg.LAPSUser != "" {
		return cfg.LAPSUser
	}
	return branding.LAPSDefaultUser
}

// resetRuntimeConfigCacheForTest — vidange explicite, usage tests uniquement.
func resetRuntimeConfigCacheForTest() {
	runtimeCfgMu.Lock()
	defer runtimeCfgMu.Unlock()
	runtimeCfgCache = RuntimeConfig{}
	runtimeCfgFetchAt = time.Time{}
}
