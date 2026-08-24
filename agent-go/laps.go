package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// LAPSRotationInterval — fréquence de rotation du mdp admin local.
// 30j pour suivre la cadence du token + Microsoft LAPS standard.
const LAPSRotationInterval = 30 * 24 * time.Hour

// passwordCharset — sans caractères ambigus (I, l, O, 0, 1) ni spéciaux
// problématiques pour la CLI Windows. 16+ chars de cet alphabet ≈ 95+ bits
// d'entropie, largement suffisant pour un compte local.
const passwordCharset = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_"

// generateAdminPassword — produit un password cryptographique aléatoire
// de la longueur demandée. Refus < 16 chars.
func generateAdminPassword(length int) (string, error) {
	if length < 16 {
		length = 16
	}
	out := make([]byte, length)
	for i := range out {
		// rejection sampling pour éviter le biais modulo
		var n [1]byte
		for {
			if _, err := rand.Read(n[:]); err != nil {
				return "", err
			}
			max := byte(256 - (256 % len(passwordCharset)))
			if n[0] < max {
				out[i] = passwordCharset[int(n[0])%len(passwordCharset)]
				break
			}
		}
	}
	return string(out), nil
}

// encryptAdminPassword — chiffre via RSA-OAEP-SHA256 avec la clé publique
// LAPS embarquée. Retourne le ciphertext brut (pas base64).
func encryptAdminPassword(plain string) ([]byte, error) {
	if lapsPubKey == nil {
		return nil, errors.New("clé publique LAPS absente du binaire")
	}
	return rsa.EncryptOAEP(sha256.New(), rand.Reader, lapsPubKey, []byte(plain), nil)
}

// MaybeRotateAdminPassword — appelé après un checkin réussi.
// Décide s'il faut rotater (intervalle ou force flag serveur) puis le fait.
//
// force : posé par la réponse checkin (rotate_admin_password) quand un
// admin a vu le mot de passe (rotate-after-view) ou demandé une rotation.
//
// Échec de la rotation : non bloquant, retry au prochain cycle.
func MaybeRotateAdminPassword(ctx context.Context, cfg *Config, st *State, force bool) {
	if !cfg.LAPSEnabled {
		return // explicitement désactivé
	}
	if lapsPubKey == nil {
		logWarn("laps-no-pubkey", "LAPS activé mais clé publique absente du binaire", nil)
		return
	}

	// Un ciphertext en attente (POST échoué après un set local) passe avant
	// tout : le mot de passe local actuel n'est pas escrowé côté serveur.
	// Tant qu'il n'est pas flushé, on ne re-rotate pas — re-changer le mot
	// de passe toutes les 15 min pendant une panne n'apporte rien.
	if st.PendingAdminCred != nil {
		enc, err := base64.StdEncoding.DecodeString(st.PendingAdminCred.EncB64)
		if err != nil {
			logError("laps-stash-corrompu", err, nil)
			st.PendingAdminCred = nil
			st.Save()
			// stash inutilisable → on retombe sur une rotation normale ci-dessous
		} else if err := postAdminCredential(ctx, cfg, st.PendingAdminCred.Username, enc); err != nil {
			logWarn("laps-stash-flush-fail", "retry au prochain checkin", LogFields{"error": err.Error()})
			return
		} else {
			// Le serveur connaît désormais le mot de passe posé au moment du
			// stash — l'horloge de rotation repart de là.
			st.LastAdminRotation = st.PendingAdminCred.StashedAt
			st.PendingAdminCred = nil
			st.Save()
			logInfo("laps-stash-flushed", "ciphertext en attente remonté", nil)
			if !force {
				return
			}
		}
	}

	if !force && !st.LastAdminRotation.IsZero() && time.Since(st.LastAdminRotation) < LAPSRotationInterval {
		return
	}

	password, err := generateAdminPassword(32)
	if err != nil {
		logError("laps-genpw-fail", err, nil)
		return
	}

	username := cfg.lapsUser()
	if err := setLocalAdminPassword(username, password); err != nil {
		logError("laps-set-fail", err, LogFields{"user": username})
		// Le compte est peut-être absent ou la machine pas Windows. On ne
		// retourne pas l'erreur via push : c'est de l'admin opérationnel.
		return
	}

	encrypted, err := encryptAdminPassword(password)
	if err != nil {
		logError("laps-encrypt-fail", err, nil)
		return
	}

	if err := postAdminCredential(ctx, cfg, username, encrypted); err != nil {
		logError("laps-post-fail", err, nil)
		// On vient de changer le mdp local mais le serveur ne l'a pas reçu.
		// → l'admin est verrouillé hors du compte recovery. Sticky : on
		// retry au prochain checkin. Le password reste en mémoire ici → perdu
		// au crash. L'admin doit alors trigger une rotation manuelle.
		// Mitigation : on persiste l'encrypted en state.json en attendant.
		stashPendingAdminCred(st, username, encrypted)
		return
	}

	st.LastAdminRotation = time.Now().UTC()
	st.Save()
	logInfo("laps-rotated", "", LogFields{
		"user":          username,
		"next_rotation": st.LastAdminRotation.Add(LAPSRotationInterval).Format(time.RFC3339),
	})
}

// stashPendingAdminCred — best-effort : on garde le ciphertext en state
// pour retry (drainé en tête de MaybeRotateAdminPassword). Si même ça
// échoue, le mdp est perdu → admin doit redéclencher une rotation depuis
// l'UI (qui pose le flag rotate_admin_password).
func stashPendingAdminCred(st *State, username string, encrypted []byte) {
	st.PendingAdminCred = &PendingAdminCred{
		Username:  username,
		EncB64:    base64.StdEncoding.EncodeToString(encrypted),
		StashedAt: time.Now().UTC(),
	}
	st.Save()
}

func postAdminCredential(ctx context.Context, cfg *Config, username string, encrypted []byte) error {
	body, err := json.Marshal(map[string]string{
		"username":           username,
		"encrypted_password": base64.StdEncoding.EncodeToString(encrypted),
	})
	if err != nil {
		return err
	}
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodPost,
		cfg.URL+"/api/agent/admin-credential", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.GetToken())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP : %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
