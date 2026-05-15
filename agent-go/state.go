package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"time"
)

// State — données persistées entre exécutions, écrites dans state.json.
// Sert à : (1) suivre un update récent pour détecter les checkins échoués
// et déclencher un rollback, (2) garder en mémoire des résultats de
// déploiement non encore remontés (cohérence avec l'agent PowerShell).
type State struct {
	LastUpdateAt        time.Time          `json:"last_update_at,omitempty"`
	LastUpdateVersion   string             `json:"last_update_version,omitempty"`
	FailedSinceUpdate   int                `json:"failed_since_update,omitempty"`
	PendingDeployments  []DeploymentResult `json:"pending_deployments,omitempty"`
	PendingDetections   []DetectionResult  `json:"pending_detections,omitempty"`

	// Tamper detection : SHA-256 du binaire au moment de l'install ou
	// du dernier auto-update. Comparé au hash courant à chaque démarrage.
	BinarySHA256      string    `json:"binary_sha256,omitempty"`
	BinaryUpdatedAt   time.Time `json:"binary_updated_at,omitempty"`

	// Token rotation : timestamp de la dernière rotation. Si zero, c'est
	// soit un agent fraîchement installé, soit un agent legacy passant en
	// rotation pour la première fois (cf. MaybeRotateToken).
	LastTokenRotation time.Time `json:"last_token_rotation,omitempty"`

	// LAPS : timestamp de la dernière rotation du mdp admin local.
	LastAdminRotation time.Time         `json:"last_admin_rotation,omitempty"`
	// PendingAdminCred : ciphertext stash si le POST au serveur a échoué
	// après un set local. Re-envoyé au prochain checkin.
	PendingAdminCred  *PendingAdminCred `json:"pending_admin_cred,omitempty"`
}

// PendingAdminCred — ciphertext en attente d'envoi au serveur.
type PendingAdminCred struct {
	Username  string    `json:"username"`
	EncB64    string    `json:"enc_b64"`
	StashedAt time.Time `json:"stashed_at"`
}

func LoadState() *State {
	raw, err := os.ReadFile(statePath())
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("state read err (non bloquant) : %v", err)
		}
		return &State{}
	}
	var s State
	if err := json.Unmarshal(raw, &s); err != nil {
		logf("state parse err (non bloquant) : %v", err)
		return &State{}
	}
	return &s
}

func (s *State) Save() {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		logf("state marshal err : %v", err)
		return
	}
	if err := os.WriteFile(statePath(), raw, 0o600); err != nil {
		logf("state write err : %v", err)
	}
}
