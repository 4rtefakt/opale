package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// userAgent — string utilisée pour le header HTTP User-Agent. Inclut
// GOOS/GOARCH pour que le serveur puisse servir le bon binaire au
// moment d'un auto-update (matrice amd64/arm64).
func userAgent() string {
	return fmt.Sprintf("%s/%s (%s/%s)",
		branding.UserAgentSlug, AgentVersion, runtime.GOOS, runtime.GOARCH)
}

// httpClient — TLS strict (jamais InsecureSkipVerify), timeout serré.
// VerifyPeerCertificate ajoute le SPKI pinning AU-DESSUS de la validation
// CA standard (host check, expiration, chaîne) — pas de fallback.
var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:            tls.VersionTLS12,
			VerifyPeerCertificate: verifyPeerSPKI,
		},
	},
}

// DoCheckin collecte les métriques, envoie le POST, et retourne la réponse
// du serveur (commandes, déploiements, agent_update). En cas d'échec réseau,
// retourne une erreur — le caller doit incrémenter le compteur de rollback.
func DoCheckin(ctx context.Context, cfg *Config, st *State) (*CheckinResponse, error) {
	payload, err := CollectMetrics()
	if err != nil {
		return nil, fmt.Errorf("collecte métriques : %w", err)
	}
	payload.AgentVersion = AgentVersion
	payload.DeploymentResults = drainDeploymentResults(st)
	payload.DetectionResults = drainDetectionResults(st)
	payload.Tamper = runtimeTamper // nil = champ absent dans le JSON

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload : %w", err)
	}

	url := cfg.URL + "/api/agent/checkin"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("new request : %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("POST checkin : %w", err)
	}
	defer resp.Body.Close()

	rawResp, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("lecture réponse : %w", err)
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d : %s", resp.StatusCode, truncate(string(rawResp), 200))
	}

	var out CheckinResponse
	if err := json.Unmarshal(rawResp, &out); err != nil {
		return nil, fmt.Errorf("parse réponse : %w", err)
	}
	if !out.OK {
		return nil, errors.New("checkin response ok=false")
	}
	return &out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// postCommandResult — POST /api/agent/result avec le résultat d'un script.
// Non bloquant : si le serveur est inaccessible, on log et on continue
// (le script_executions row reste 'running' jusqu'au prochain succès,
// mais c'est une cohérence eventually consistent côté UI).
func postCommandResult(ctx context.Context, cfg *Config, executionID string, exitCode int, output string) error {
	body, err := json.Marshal(map[string]any{
		"execution_id": executionID,
		"exit_code":    exitCode,
		"output":       output,
	})
	if err != nil {
		return err
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodPost, cfg.URL+"/api/agent/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func drainDeploymentResults(st *State) []DeploymentResult {
	out := st.PendingDeployments
	if out == nil {
		out = []DeploymentResult{}
	}
	st.PendingDeployments = nil
	return out
}

func drainDetectionResults(st *State) []DetectionResult {
	out := st.PendingDetections
	if out == nil {
		out = []DetectionResult{}
	}
	st.PendingDetections = nil
	return out
}
