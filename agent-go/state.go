package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
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
	// PendingAdminCred : rotation en cours (cf. machine à états dans
	// laps.go). Phase vide = stash écrit par un agent ≤ 2.14 (mdp appliqué
	// localement, POST échoué) : renvoyé tel quel au prochain cycle.
	PendingAdminCred  *PendingAdminCred `json:"pending_admin_cred,omitempty"`
	// CurrentAdminCred : ciphertext du dernier mdp appliqué localement ET
	// escrowé. Sert à réaligner le serveur si une rotation échoue après
	// l'escrow. Jamais de mot de passe en clair sur disque.
	CurrentAdminCred *AdminCredRecord `json:"current_admin_cred,omitempty"`
	// LAPSManagedSIDs : comptes locaux créés (ou adoptés, cf.
	// checkLAPSAccountManageable) par l'agent — seuls comptes existants
	// qu'il accepte de rotater.
	LAPSManagedSIDs []string `json:"laps_managed_sids,omitempty"`
	// Backoff après échec de rotation LAPS.
	LAPSFailures   int       `json:"laps_failures,omitempty"`
	LAPSRetryAfter time.Time `json:"laps_retry_after,omitempty"`
}

// PendingAdminCred — ciphertext d'une rotation LAPS en cours.
type PendingAdminCred struct {
	Username  string    `json:"username"`
	EncB64    string    `json:"enc_b64"`
	StashedAt time.Time `json:"stashed_at"`
	// Phase : "" (legacy ≤ 2.14), "prepared" (persisté, escrow non
	// confirmé, mdp local inchangé) ou "escrowed" (escrow confirmé,
	// application locale non confirmée).
	Phase string `json:"phase,omitempty"`
}

// AdminCredRecord — ciphertext d'un mdp appliqué et escrowé.
type AdminCredRecord struct {
	Username string    `json:"username"`
	EncB64   string    `json:"enc_b64"`
	At       time.Time `json:"at"`
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

// Save persiste le state de façon atomique (cf. writeFileAtomic). L'erreur
// est loggée ET retournée : la plupart des appelants l'ignorent (best
// effort), mais la LAPS en a besoin pour ne pas envoyer un mot de passe
// dont elle ne garderait aucune trace sur disque.
func (s *State) Save() error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		logf("state marshal err : %v", err)
		return err
	}
	if err := writeFileAtomic(statePath(), raw, 0o600); err != nil {
		logf("state write err : %v", err)
		return err
	}
	return nil
}

// writeFileAtomic écrit data dans path sans jamais exposer de fichier
// partiel : fichier temporaire au nom aléatoire dans le MÊME dossier (le
// rename n'est atomique que sur un même volume), fsync, puis rename sur la
// cible (MoveFileEx REPLACE_EXISTING sous Windows, rename(2) ailleurs).
// Un crash ou une coupure de courant laisse l'ancienne ou la nouvelle
// version, jamais un fichier tronqué. Le temporaire hérite de l'ACL du
// data dir (SYSTEM + Administrateurs sous Windows).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	fail := func(err error) error {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if _, err := f.Write(data); err != nil {
		return fail(err)
	}
	if err := f.Chmod(perm); err != nil && runtime.GOOS != "windows" {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := renameWithRetry(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// Persistance du rename lui-même (POSIX). Sans effet sous Windows, où
	// l'ouverture d'un dossier en écriture n'est pas supportée : ignoré.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// renameWithRetry — sous Windows, un rename vers un fichier ouvert sans
// FILE_SHARE_DELETE (antivirus, indexeur) échoue transitoirement : on
// réessaie brièvement avant d'abandonner (l'ancien fichier reste intact).
func renameWithRetry(from, to string) error {
	var err error
	for attempt := 1; attempt <= 5; attempt++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt) * 20 * time.Millisecond)
	}
	return err
}
