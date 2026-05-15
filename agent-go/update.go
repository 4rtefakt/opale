package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// MaxFailedSinceUpdate — au-delà de ce nombre de checkins échoués
// consécutifs après une mise à jour, on rollback vers le binaire précédent.
const MaxFailedSinceUpdate = 2

// HandleAgentUpdate orchestre la mise à jour si une nouvelle version est
// proposée par le serveur. Toute erreur de vérification (sha256 ou ed25519)
// est fatale pour cette tentative — on n'écrase jamais le binaire actuel.
//
// Si l'update aboutit, la fonction redémarre le service et n'est jamais
// supposée retourner (os.Exit). Sinon, retourne nil ou une erreur.
func HandleAgentUpdate(ctx context.Context, cfg *Config, st *State, upd *AgentUpdate) error {
	if upd == nil {
		return nil
	}
	if upd.LatestVersion == "" || upd.SHA256 == "" || upd.Signature == "" {
		return errors.New("agent_update incomplet (version/sha256/signature manquants)")
	}
	if !semverGT(upd.LatestVersion, AgentVersion) {
		// Le serveur peut ré-envoyer la même version par paranoïa ; ignore.
		return nil
	}
	logInfo("update-start", "", LogFields{"from": AgentVersion, "to": upd.LatestVersion})

	// 1. Télécharger
	bin, err := downloadBinary(ctx, cfg, upd)
	if err != nil {
		return fmt.Errorf("download : %w", err)
	}

	// 2. Vérifier SHA-256 (intégrité transport)
	gotSHA := sha256.Sum256(bin)
	wantSHA, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(upd.SHA256)))
	if err != nil {
		return fmt.Errorf("sha256 attendu mal formé : %w", err)
	}
	if !bytesEqual(gotSHA[:], wantSHA) {
		return fmt.Errorf("sha256 mismatch (téléchargement corrompu ou serveur compromis)")
	}

	// 3. Vérifier signature ed25519 (authenticité)
	sig, err := base64.StdEncoding.DecodeString(upd.Signature)
	if err != nil {
		return fmt.Errorf("signature base64 invalide : %w", err)
	}
	if err := VerifyBinarySignature(bin, sig); err != nil {
		return fmt.Errorf("vérification signature : %w (binaire rejeté)", err)
	}

	logInfo("update-verified", "", LogFields{
		"version": upd.LatestVersion,
		"bytes":   len(bin),
		"sha256":  upd.SHA256,
	})

	// 4. Écrire le nouveau binaire à côté
	if err := os.WriteFile(newBinPath(), bin, 0o755); err != nil {
		return fmt.Errorf("écriture %s : %w", newBinPath(), err)
	}

	// 5. Permuter atomiquement (rename = atomique sur NTFS et POSIX)
	if err := atomicReplace(); err != nil {
		// Nettoyer le .new pour ne pas accumuler
		_ = os.Remove(newBinPath())
		return fmt.Errorf("atomic replace : %w", err)
	}

	// 6. Persister l'état pour le rollback éventuel + nouveau baseline tamper.
	// La nouvelle instance comparera son propre hash à st.BinarySHA256 et doit
	// y trouver le hash post-update — sinon elle déclencherait un faux positif
	// au démarrage.
	st.LastUpdateAt = time.Now().UTC()
	st.LastUpdateVersion = upd.LatestVersion
	st.FailedSinceUpdate = 0
	st.BinarySHA256 = strings.ToLower(upd.SHA256)
	st.BinaryUpdatedAt = st.LastUpdateAt
	st.Save()

	logInfo("update-applied", "binaire remplacé, redémarrage du service", LogFields{
		"version": upd.LatestVersion,
	})
	// 7. Redémarrer le service — n'est pas supposé retourner.
	return restartService()
}

// atomicReplace : binary.exe → backup ; new.exe → binary.exe.
// Sur Windows, on peut renommer un .exe en cours d'exécution (mais pas
// le supprimer ni l'écraser), donc cette séquence fonctionne tant que
// le service tourne encore. Le SCM démarrera la nouvelle copie après
// le restart.
func atomicReplace() error {
	cur := binaryPath()
	bak := backupPath()
	new := newBinPath()

	// Si un ancien backup existe (de la précédente update), on le supprime.
	_ = os.Remove(bak)

	// Renommer le binaire courant en .bak (ok sur Windows car on est en
	// cours d'exécution depuis ce fichier — Windows autorise rename, pas
	// delete/replace).
	if err := os.Rename(cur, bak); err != nil {
		return fmt.Errorf("rename %s → %s : %w", cur, bak, err)
	}
	// Promouvoir le .new
	if err := os.Rename(new, cur); err != nil {
		// Roll-back de l'étape précédente
		_ = os.Rename(bak, cur)
		return fmt.Errorf("rename %s → %s : %w", new, cur, err)
	}
	return nil
}

// CheckRollback est appelé après un checkin. Si on est dans la fenêtre
// post-update et qu'un seuil d'échecs consécutifs est atteint, on
// restaure le binaire précédent et on redémarre.
func CheckRollback(st *State, lastCheckinErr error) {
	// Pas d'update récent à surveiller
	if st.LastUpdateAt.IsZero() {
		return
	}

	if lastCheckinErr == nil {
		// Le nouvel agent fonctionne — sortie de la fenêtre de surveillance
		if st.FailedSinceUpdate != 0 || st.LastUpdateVersion != "" {
			logInfo("update-validated", "1er checkin réussi", LogFields{
				"version": st.LastUpdateVersion,
			})
		}
		st.LastUpdateAt = time.Time{}
		st.LastUpdateVersion = ""
		st.FailedSinceUpdate = 0
		st.Save()
		return
	}

	st.FailedSinceUpdate++
	st.Save()

	if st.FailedSinceUpdate < MaxFailedSinceUpdate {
		logWarn("update-checkin-fail", "checkin échoué après update", LogFields{
			"version": st.LastUpdateVersion,
			"failed":  st.FailedSinceUpdate,
			"max":     MaxFailedSinceUpdate,
		})
		return
	}

	logWarn("update-rollback-trigger", "seuil atteint, rollback", LogFields{
		"version": st.LastUpdateVersion,
		"failed":  st.FailedSinceUpdate,
	})
	if err := rollback(); err != nil {
		logError("rollback-fail", err, LogFields{"version": st.LastUpdateVersion})
		return
	}
	logInfo("rollback-applied", "binaire restauré", LogFields{"to": "previous"})
	// Reset l'état pour que la prochaine instance ne re-rollback pas
	st.LastUpdateAt = time.Time{}
	st.LastUpdateVersion = ""
	st.FailedSinceUpdate = 0
	st.Save()
	// Redémarrer pour charger le binaire restauré
	_ = restartService()
}

func rollback() error {
	cur := binaryPath()
	bak := backupPath()
	if _, err := os.Stat(bak); err != nil {
		return fmt.Errorf("backup absent (%s) : %w", bak, err)
	}
	failed := cur + ".failed"
	_ = os.Remove(failed)
	if err := os.Rename(cur, failed); err != nil {
		return fmt.Errorf("rename current → failed : %w", err)
	}
	if err := os.Rename(bak, cur); err != nil {
		_ = os.Rename(failed, cur)
		return fmt.Errorf("rename backup → current : %w", err)
	}
	return nil
}

func downloadBinary(ctx context.Context, cfg *Config, upd *AgentUpdate) ([]byte, error) {
	url := upd.DownloadURL
	if strings.HasPrefix(url, "/") {
		url = cfg.URL + url
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	// Limite raisonnable : un agent Go statique fait ~10–20 MiB
	return io.ReadAll(io.LimitReader(resp.Body, 100*1024*1024))
}

// semverGT — comparaison stricte X.Y.Z. Aligné avec api/routes/agent.js semverGt.
func semverGT(a, b string) bool {
	pa := parseVer(a)
	pb := parseVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] > pb[i] {
			return true
		}
		if pa[i] < pb[i] {
			return false
		}
	}
	return false
}

func parseVer(s string) [3]int {
	var out [3]int
	parts := strings.Split(s, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		out[i] = atoiSafe(parts[i])
	}
	return out
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
