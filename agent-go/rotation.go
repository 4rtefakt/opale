package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// TokenRotationInterval — fréquence de rotation. 30j = compromis entre
// limiter le blast radius d'une fuite et éviter le churn opérationnel.
const TokenRotationInterval = 30 * 24 * time.Hour

type rotateTokenResponse struct {
	Token        string `json:"token"`
	ExpiresAtOld string `json:"expires_at_old"`
}

// MaybeRotateToken — appelé après chaque checkin réussi. Décide s'il faut
// rotater, demande un nouveau token, et persiste atomiquement.
//
// Premier passage (LastTokenRotation == zero) : on enregistre la date du
// jour SANS rotater. Évite que tous les agents rotent en même temps lors
// du déploiement de cette feature.
//
// Échec de rotation : non bloquant. Log warn, retry au prochain cycle.
// L'ancien token reste valide tant qu'il n'a pas expiré côté serveur.
func MaybeRotateToken(ctx context.Context, cfg *Config, st *State) {
	if st.LastTokenRotation.IsZero() {
		st.LastTokenRotation = time.Now().UTC()
		st.Save()
		logInfo("token-rotation-baseline", "horloge rotation initialisée", LogFields{
			"next_rotation": st.LastTokenRotation.Add(TokenRotationInterval).Format(time.RFC3339),
		})
		return
	}
	if time.Since(st.LastTokenRotation) < TokenRotationInterval {
		return
	}

	newToken, err := requestNewToken(ctx, cfg)
	if err != nil {
		logWarn("token-rotation-fail", "non bloquant, retry au prochain cycle", LogFields{
			"error": err.Error(),
		})
		return
	}

	// On garde une copie de l'ancien token pour rollback en cas d'échec
	// d'écriture du config.json.
	oldToken := cfg.Token
	cfg.Token = newToken
	if err := cfg.Save(); err != nil {
		logError("token-rotation-save-fail", err, LogFields{
			"hint": "ancien token toujours actif côté serveur (grace 24h)",
		})
		cfg.Token = oldToken
		return
	}

	st.LastTokenRotation = time.Now().UTC()
	st.Save()
	logInfo("token-rotated", "", LogFields{
		"next_rotation": st.LastTokenRotation.Add(TokenRotationInterval).Format(time.RFC3339),
	})
}

func requestNewToken(ctx context.Context, cfg *Config) (string, error) {
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(c, http.MethodPost,
		cfg.URL+"/api/agent/rotate-token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("HTTP : %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out rotateTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode : %w", err)
	}
	if len(out.Token) < 32 {
		return "", errors.New("token reçu trop court (suspect)")
	}
	return out.Token, nil
}
