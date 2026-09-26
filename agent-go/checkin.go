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
	"unicode/utf8"

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

// collectMetricsFn — indirection pour les tests (la collecte réelle
// échantillonne le CPU pendant ~5 s et pingue une IP publique).
var collectMetricsFn = CollectMetrics

// DoCheckin collecte les métriques, envoie le POST, et retourne la réponse
// du serveur (commandes, déploiements, agent_update). En cas d'échec réseau,
// retourne une erreur — le caller doit incrémenter le compteur de rollback.
//
// Les résultats en attente (state) partent SANS être retirés de l'état : ils
// ne le sont qu'une fois la réponse acceptée (HTTP 200, JSON ok). Sur toute
// erreur ils restent en file (et dans state.json) et repartent au checkin
// suivant ; le serveur ignore un résultat qu'il a déjà reçu.
func DoCheckin(ctx context.Context, cfg *Config, st *State) (*CheckinResponse, error) {
	payload, err := collectMetricsFn()
	if err != nil {
		return nil, fmt.Errorf("collecte métriques : %w", err)
	}
	payload.AgentVersion = AgentVersion
	payload.DeploymentResults = pendingDeploymentBatch(st)
	payload.DetectionResults = pendingDetectionBatch(st)
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
	req.Header.Set("Authorization", "Bearer "+cfg.token())
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
	ackPendingResults(st, len(payload.DeploymentResults), len(payload.DetectionResults))
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
	req.Header.Set("Authorization", "Bearer "+cfg.token())
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

// maxResultOutputBytes — taille max de la sortie d'un résultat de
// déploiement envoyée au serveur (début et fin conservés). Un résultat
// refusé reste en file : sans borne, une sortie énorme ferait refuser (413)
// chaque checkin, indéfiniment.
const maxResultOutputBytes = 64 * 1024

// maxResultsBatchBytes — budget JSON des résultats de déploiement d'un
// checkin, sous la limite de corps du serveur (1 Mio par défaut). Le reste
// part au checkin suivant ; au moins un résultat par checkin.
const maxResultsBatchBytes = 512 * 1024

// pendingDeploymentBatch — copie des premiers résultats de déploiement en
// attente, dans l'ordre, sorties tronquées, dans la limite du budget.
// L'état n'est pas modifié (cf. ackPendingResults).
func pendingDeploymentBatch(st *State) []DeploymentResult {
	out := []DeploymentResult{}
	size := 0
	for _, r := range st.PendingDeployments {
		r.Output = truncateMiddle(r.Output, maxResultOutputBytes)
		raw, _ := json.Marshal(r)
		if len(out) > 0 && size+len(raw) > maxResultsBatchBytes {
			break
		}
		out = append(out, r)
		size += len(raw)
	}
	return out
}

// pendingDetectionBatch — copie des résultats de détection en attente
// (quelques dizaines d'octets chacun : tous envoyés).
func pendingDetectionBatch(st *State) []DetectionResult {
	return append([]DetectionResult{}, st.PendingDetections...)
}

// ackPendingResults retire de l'état les nDep premiers résultats de
// déploiement et les nDet premiers de détection : ceux du checkin que le
// serveur vient d'accepter, pas ce qui a été ajouté en file depuis la
// copie envoyée. State n'a pas de verrou : seule la goroutine des checkins
// (runCheckin) le lit et l'écrit, DoCheckin compris ; les entrées
// s'ajoutent en fin de file, seul DoCheckin en retire, en tête.
func ackPendingResults(st *State, nDep, nDet int) {
	st.PendingDeployments = dropPrefix(st.PendingDeployments, nDep)
	st.PendingDetections = dropPrefix(st.PendingDetections, nDet)
}

func dropPrefix[T any](s []T, n int) []T {
	if n >= len(s) {
		return nil
	}
	return append([]T(nil), s[n:]...)
}

// truncateMiddle — s ramenée à limit octets au plus : début et fin
// conservés (un installeur conclut souvent en fin de sortie), coupure sur
// des frontières de caractères UTF-8.
func truncateMiddle(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	const marker = "\n[… sortie tronquée …]\n"
	half := (limit - len(marker)) / 2
	head := half
	for head > 0 && !utf8.RuneStart(s[head]) {
		head--
	}
	tail := len(s) - half
	for tail < len(s) && !utf8.RuneStart(s[tail]) {
		tail++
	}
	return s[:head] + marker + s[tail:]
}
