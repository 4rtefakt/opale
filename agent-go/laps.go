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
	"strconv"
	"strings"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
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
//
// Contient toujours au moins une minuscule, une majuscule et un chiffre
// (tirage rejeté sinon, ce qui garde la distribution uniforme sur les
// mots de passe acceptés) : la stratégie de complexité Windows (3
// catégories sur 4) ne doit jamais faire échouer l'application locale,
// qui a lieu APRÈS l'escrow.
func generateAdminPassword(length int) (string, error) {
	if length < 16 {
		length = 16
	}
	for {
		pw, err := randomPassword(length)
		if err != nil {
			return "", err
		}
		if strings.ContainsAny(pw, "abcdefghijkmnopqrstuvwxyz") &&
			strings.ContainsAny(pw, "ABCDEFGHJKLMNPQRSTUVWXYZ") &&
			strings.ContainsAny(pw, "23456789") {
			return pw, nil
		}
	}
}

func randomPassword(length int) (string, error) {
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

// ─── Machine à états de la rotation LAPS ───────────────────────────────────
//
// Invariant visé : le mot de passe escrowé côté serveur (une seule ligne par
// poste, écrasée à chaque POST /api/agent/admin-credential) est celui du
// compte local. L'agent ne peut pas déchiffrer (il n'a que la clé publique) :
// il ne conserve que des ciphertexts, jamais le mot de passe en clair sur
// disque.
//
// Ordre d'une rotation :
//
//  1. générer le mot de passe, le chiffrer ;
//  2. persister le stash (phase "prepared") — si l'écriture échoue on
//     s'arrête : jamais de POST sans trace sur disque ;
//  3. POST escrow — échec : le mot de passe local n'a PAS changé, le stash
//     reste "prepared" ;
//  4. passer le stash en phase "escrowed" (persisté, best effort) ;
//  5. appliquer localement (création du compte si besoin) ;
//  6. succès : CurrentAdminCred = ce ciphertext, LastAdminRotation = now,
//     stash effacé, le tout persisté.
//
// Reprise au cycle suivant (ou après un crash) :
//
//   - stash legacy (Phase vide, écrit par un agent ≤ 2.14 qui appliquait le
//     mot de passe AVANT l'escrow) : ce mot de passe est en place sur le
//     poste mais inconnu du serveur → on le renvoie tel quel avant toute
//     rotation, et aucune rotation tant que ce renvoi échoue. Exception :
//     s'il est antérieur à LastAdminRotation, une rotation ultérieure a été
//     escrowée avec succès → stash périmé, supprimé sans envoi.
//   - stash "prepared" : l'application locale n'a jamais été tentée, le
//     poste a toujours l'ancien mot de passe ; mais le POST a pu atteindre le
//     serveur (timeout après commit). On ré-escrowe CurrentAdminCred (s'il
//     est connu) pour resynchroniser le serveur, puis on refait une rotation
//     complète immédiatement (roll-forward).
//   - stash "escrowed" : le serveur a le nouveau mot de passe, le poste l'a
//     peut-être (crash entre application et effacement du stash) ou pas. On
//     ne sait pas lequel est en place → on NE restaure PAS l'ancien escrow et
//     on refait une rotation complète immédiatement : dès qu'elle aboutit,
//     serveur et poste sont de nouveau alignés.
//
// Échec de l'application locale après un escrow réussi (étape 5) :
//
//   - mot de passe local certainement inchangé (script arrêté avant ou
//     pendant Set-LocalUser / New-LocalUser) : le serveur détient un mot de
//     passe qui n'est pas en place. Si CurrentAdminCred est connu, on le
//     ré-escrowe (le serveur retrouve l'ancien mot de passe, qui est bien
//     celui du poste) et le stash est effacé ; sinon (premier cycle après
//     une mise à jour depuis 2.14) le stash reste "escrowed" → roll-forward.
//   - mot de passe changé mais étapes suivantes en échec (activation,
//     groupe Administrateurs) : serveur et poste sont alignés sur le nouveau
//     mot de passe → CurrentAdminCred mis à jour, stash effacé, mais
//     LastAdminRotation inchangé pour réessayer la rotation complète.
//   - issue incertaine (timeout, crash de PowerShell) : stash "escrowed",
//     pas de restauration → roll-forward.
//
// Tout échec arme un backoff exponentiel (15 min → 24 h) pour ne pas
// marteler le serveur (chaque POST écrase l'escrow et journalise un audit).
// ────────────────────────────────────────────────────────────────────────────

// Phases du stash PendingAdminCred (Phase vide = stash legacy ≤ 2.14).
const (
	lapsPhasePrepared = "prepared"
	lapsPhaseEscrowed = "escrowed"
)

// Backoff après un échec de rotation : 15 min (≈ prochain checkin), doublé
// à chaque échec consécutif, plafonné à 24 h.
const (
	lapsBackoffBase = 15 * time.Minute
	lapsBackoffMax  = 24 * time.Hour
)

// lapsSetOutcome — issue de l'application locale du mot de passe.
type lapsSetOutcome int

const (
	// lapsSetOK : mot de passe en place, compte activé et administrateur.
	lapsSetOK lapsSetOutcome = iota
	// lapsSetUnchanged : échec, le mot de passe local n'a certainement pas changé.
	lapsSetUnchanged
	// lapsSetChangedPartial : mot de passe changé, étapes suivantes en échec.
	lapsSetChangedPartial
	// lapsSetUncertain : échec, impossible de savoir si le mot de passe a changé.
	lapsSetUncertain
)

func (o lapsSetOutcome) String() string {
	switch o {
	case lapsSetOK:
		return "ok"
	case lapsSetUnchanged:
		return "unchanged"
	case lapsSetChangedPartial:
		return "changed-partial"
	case lapsSetUncertain:
		return "uncertain"
	}
	return fmt.Sprintf("outcome(%d)", int(o))
}

// lapsApplyResult — retour de lapsAccountStore.apply.
type lapsApplyResult struct {
	Outcome lapsSetOutcome
	SID     string // SID du compte si connu (création / mise à jour)
	Err     error
}

// lapsAccount — état d'un compte local tel que vu avant la rotation.
type lapsAccount struct {
	Exists      bool
	SID         string
	Description string
}

// lapsAccountStore — accès aux comptes locaux. Implémenté par la couche
// Windows (PowerShell) ; remplacé par un fake dans les tests.
type lapsAccountStore interface {
	// lookup — état du compte (Exists=false s'il n'existe pas).
	lookup(username string) (lapsAccount, error)
	// apply — crée le compte (acct.Exists=false) ou change le mot de passe
	// du compte acct.SID ; refuse si l'état a changé depuis lookup.
	apply(username, password string, acct lapsAccount) lapsApplyResult
}

// lapsRotator — dépendances injectables de la machine à états.
type lapsRotator struct {
	escrow      func(ctx context.Context, username string, encrypted []byte) error
	accounts    lapsAccountStore
	encrypt     func(plain string) ([]byte, error)
	genPassword func() (string, error)
	save        func() error
	now         func() time.Time
	// username est résolu paresseusement (runtime-config réseau) : seulement
	// quand une rotation doit réellement avoir lieu.
	username func() string
}

// MaybeRotateAdminPassword — appelé après un checkin réussi. Renvoie un
// éventuel stash en attente, puis décide s'il faut rotater (intervalle,
// rotation interrompue) et le fait. Non bloquant : les échecs sont loggés
// et retentés au cycle suivant (avec backoff).
//
// Force-flag : transmis via la réponse checkin, à ajouter dans v3.0.
// Pour le moment, seul l'intervalle déclenche.
func MaybeRotateAdminPassword(ctx context.Context, cfg *Config, st *State) {
	if !cfg.LAPSEnabled {
		return // explicitement désactivé
	}
	if lapsPubKey == nil {
		logWarn("laps-no-pubkey", "LAPS activé mais clé publique absente du binaire", nil)
		return
	}
	r := &lapsRotator{
		escrow: func(ctx context.Context, username string, encrypted []byte) error {
			return postAdminCredential(ctx, cfg, username, encrypted)
		},
		accounts:    platformLAPSAccounts(),
		encrypt:     encryptAdminPassword,
		genPassword: func() (string, error) { return generateAdminPassword(32) },
		save:        st.Save,
		now:         time.Now,
		username:    cfg.lapsUser,
	}
	r.run(ctx, st)
}

func (r *lapsRotator) run(ctx context.Context, st *State) {
	now := r.now().UTC()
	// Backoff après un échec récent. Une échéance à plus de lapsBackoffMax
	// (horloge corrigée en arrière) est ignorée pour ne pas bloquer la LAPS.
	if wait := st.LAPSRetryAfter.Sub(now); wait > 0 && wait <= lapsBackoffMax {
		return
	}

	// 1. Stash legacy : mot de passe en place mais jamais escrowé.
	force := false
	if p := st.PendingAdminCred; p != nil && p.Phase == "" {
		if !r.flushLegacyStash(ctx, st, now) {
			return // au plus une opération serveur de ce type par cycle
		}
		// Stash abandonné alors que son mot de passe est en place : le
		// serveur ne le connaîtra jamais → rotation complète immédiate.
		force = true
	}

	// Hors Windows (accounts nil) : aucun compte local géré, donc jamais de
	// rotation — et surtout jamais d'escrow d'un mot de passe non appliqué.
	if r.accounts == nil {
		return
	}

	// 2. Rotation interrompue ou échue ?
	pending := st.PendingAdminCred
	due := force || st.LastAdminRotation.IsZero() || now.Sub(st.LastAdminRotation) >= LAPSRotationInterval
	if pending == nil && !due {
		return
	}
	if pending != nil {
		logWarn("laps-rollforward", "rotation précédente inachevée, nouvelle rotation complète", LogFields{
			"phase":      pending.Phase,
			"user":       pending.Username,
			"stashed_at": pending.StashedAt.Format(time.RFC3339),
		})
		if pending.Phase == lapsPhasePrepared {
			// Mot de passe jamais appliqué : le poste a toujours celui de
			// CurrentAdminCred. On resynchronise le serveur au cas où le POST
			// précédent l'aurait atteint malgré l'erreur ; une fois fait,
			// serveur et poste sont alignés : le stash est soldé (pas de
			// nouveau POST de restauration à chaque cycle si la rotation
			// échoue ensuite, ex. compte refusé).
			if r.restoreCurrentEscrow(ctx, st) {
				st.PendingAdminCred = nil
				_ = r.save()
			}
		}
	}

	r.rotate(ctx, st, now)
}

// flushLegacyStash — renvoie (ou purge s'il est périmé) le stash d'un
// agent ≤ 2.14. Retourne true si le stash a été abandonné alors que son mot
// de passe est probablement en place (illisible, ou refusé définitivement
// par le serveur) : l'appelant enchaîne alors une rotation complète
// (escrow d'abord) pour réaligner serveur et poste.
func (r *lapsRotator) flushLegacyStash(ctx context.Context, st *State, now time.Time) bool {
	p := st.PendingAdminCred
	if !st.LastAdminRotation.IsZero() && st.LastAdminRotation.After(p.StashedAt) {
		logInfo("laps-legacy-stash-stale", "stash antérieur à la dernière rotation escrowée, supprimé", LogFields{
			"user":       p.Username,
			"stashed_at": p.StashedAt.Format(time.RFC3339),
		})
		st.PendingAdminCred = nil
		_ = r.save()
		return false
	}
	enc, err := base64.StdEncoding.DecodeString(p.EncB64)
	if err != nil || p.Username == "" {
		logError("laps-legacy-stash-invalid", err, LogFields{"user": p.Username})
		st.PendingAdminCred = nil
		_ = r.save()
		return true
	}
	if err := r.escrow(ctx, p.Username, enc); err != nil {
		if isPermanentEscrowRejection(err) {
			// Refus définitif (4xx hors 401/408/429) : le renvoyer à chaque
			// cycle bloquerait la LAPS indéfiniment.
			logError("laps-legacy-stash-rejected", err, LogFields{
				"user": p.Username,
				"hint": "stash abandonné, nouvelle rotation",
			})
			st.PendingAdminCred = nil
			_ = r.save()
			return true
		}
		logError("laps-legacy-stash-post-fail", err, LogFields{"user": p.Username})
		r.fail(st, now)
		_ = r.save()
		return false
	}
	st.CurrentAdminCred = &AdminCredRecord{Username: p.Username, EncB64: p.EncB64, At: now}
	st.LastAdminRotation = now
	st.PendingAdminCred = nil
	r.resetBackoff(st)
	_ = r.save()
	logInfo("laps-legacy-stash-escrowed", "mot de passe appliqué par un agent précédent enfin escrowé", LogFields{
		"user": p.Username,
	})
	return false
}

// restoreCurrentEscrow — ré-escrowe le dernier mot de passe connu comme
// appliqué localement. Retourne true si le serveur l'a accepté.
func (r *lapsRotator) restoreCurrentEscrow(ctx context.Context, st *State) bool {
	cur := st.CurrentAdminCred
	if cur == nil {
		return false
	}
	enc, err := base64.StdEncoding.DecodeString(cur.EncB64)
	if err != nil {
		logError("laps-escrow-restore-invalid", err, LogFields{"user": cur.Username})
		return false
	}
	if err := r.escrow(ctx, cur.Username, enc); err != nil {
		logError("laps-escrow-restore-fail", err, LogFields{"user": cur.Username})
		return false
	}
	logInfo("laps-escrow-restored", "escrow serveur réaligné sur le mot de passe en place", LogFields{
		"user": cur.Username,
	})
	return true
}

func (r *lapsRotator) rotate(ctx context.Context, st *State, now time.Time) {
	username := r.username()
	if username == "" {
		logWarn("laps-no-user", "nom du compte LAPS vide, rotation ignorée", nil)
		r.fail(st, now)
		_ = r.save()
		return
	}

	// Étape 0 : l'agent ne gère qu'un compte qu'il a créé (cf.
	// checkLAPSAccountManageable). Vérifié AVANT tout escrow : un compte
	// refusé ne doit pas écraser l'escrow serveur.
	acct, err := r.accounts.lookup(username)
	if err != nil {
		logError("laps-lookup-fail", err, LogFields{"user": username})
		r.fail(st, now)
		_ = r.save()
		return
	}
	if err := checkLAPSAccountManageable(username, acct, st.LAPSManagedSIDs); err != nil {
		logError("laps-account-refused", err, LogFields{"user": username, "sid": acct.SID})
		r.fail(st, now)
		_ = r.save()
		return
	}

	password, err := r.genPassword()
	if err != nil {
		logError("laps-genpw-fail", err, nil)
		r.fail(st, now)
		_ = r.save()
		return
	}
	encrypted, err := r.encrypt(password)
	if err != nil {
		logError("laps-encrypt-fail", err, nil)
		r.fail(st, now)
		_ = r.save()
		return
	}
	encB64 := base64.StdEncoding.EncodeToString(encrypted)

	// Étape 2 : trace disque AVANT tout envoi.
	previous := st.PendingAdminCred
	st.PendingAdminCred = &PendingAdminCred{
		Username:  username,
		EncB64:    encB64,
		StashedAt: now,
		Phase:     lapsPhasePrepared,
	}
	if err := r.save(); err != nil {
		logError("laps-stash-save-fail", err, LogFields{"user": username})
		st.PendingAdminCred = previous
		r.fail(st, now)
		return
	}

	// Étape 3 : escrow.
	if err := r.escrow(ctx, username, encrypted); err != nil {
		logError("laps-post-fail", err, LogFields{"user": username})
		r.fail(st, now)
		_ = r.save()
		return
	}

	// Étape 4 : le serveur détient désormais ce mot de passe. La phase
	// "escrowed" DOIT être sur disque avant l'application locale : sur
	// disque, "prepared" garantit ainsi que le mot de passe n'a jamais été
	// appliqué (ce qui autorise la restauration de CurrentAdminCred).
	st.PendingAdminCred.Phase = lapsPhaseEscrowed
	if err := r.save(); err != nil {
		logError("laps-stash-save-fail", err, LogFields{"user": username, "phase": lapsPhaseEscrowed})
		// Rien n'a été appliqué : la mémoire doit refléter "prepared" (comme
		// le disque), sinon le cycle suivant ne réalignerait pas le serveur.
		// On le réaligne tout de suite si l'ancien mot de passe est connu.
		st.PendingAdminCred.Phase = lapsPhasePrepared
		if r.restoreCurrentEscrow(ctx, st) {
			st.PendingAdminCred = nil
		}
		r.fail(st, now)
		_ = r.save()
		return
	}

	// Étape 5 : application locale.
	res := r.accounts.apply(username, password, acct)
	if res.Outcome == lapsSetOK || res.Outcome == lapsSetChangedPartial {
		sid := res.SID
		if sid == "" {
			sid = acct.SID
		}
		recordLAPSManagedSID(st, sid)
	}
	switch res.Outcome {
	case lapsSetOK:
		st.CurrentAdminCred = &AdminCredRecord{Username: username, EncB64: encB64, At: now}
		st.LastAdminRotation = now
		st.PendingAdminCred = nil
		r.resetBackoff(st)
		_ = r.save()
		logInfo("laps-rotated", "", LogFields{
			"user":          username,
			"next_rotation": now.Add(LAPSRotationInterval).Format(time.RFC3339),
		})
		return

	case lapsSetChangedPartial:
		// Serveur et poste alignés sur le nouveau mot de passe.
		st.CurrentAdminCred = &AdminCredRecord{Username: username, EncB64: encB64, At: now}
		st.PendingAdminCred = nil
		logError("laps-set-partial", res.Err, LogFields{"user": username})

	case lapsSetUnchanged:
		logError("laps-set-fail", res.Err, LogFields{"user": username, "outcome": res.Outcome.String()})
		if r.restoreCurrentEscrow(ctx, st) {
			st.PendingAdminCred = nil
		}

	default: // lapsSetUncertain
		logError("laps-set-uncertain", res.Err, LogFields{"user": username, "outcome": res.Outcome.String()})
	}
	r.fail(st, now)
	_ = r.save()
}

// checkLAPSUsernameAllowed — refuse les noms communs d'admins existants
// pour éviter un lockout si la config est mal renseignée (le serveur
// applique la même liste à la saisie du paramètre).
func checkLAPSUsernameAllowed(username string) error {
	low := strings.ToLower(strings.TrimSpace(username))
	for _, banned := range []string{"administrator", "administrateur", "admin", "root", "system"} {
		if low == banned {
			return fmt.Errorf("username interdit (compte sensible) : %s", username)
		}
	}
	return nil
}

// checkLAPSAccountManageable — règle de sécurité : l'agent ne rotate
// (et n'ajoute aux Administrateurs) qu'un compte qu'il a lui-même créé.
// Le nom du compte vient du serveur (paramètre runtime-config) : sans cette
// règle, un changement de ce paramètre suffirait à prendre la main sur
// n'importe quel compte local (Administrateur intégré renommé, compte
// d'un utilisateur…).
//
//   - nom sensible (administrator, admin…) : refusé ;
//   - compte absent : autorisé, l'agent le crée (description branding) ;
//   - compte intégré (RID < 1000 : 500 Administrateur, 501 Invité,
//     503 DefaultAccount, 504 WDAGUtilityAccount), quel que soit son nom :
//     refusé ;
//   - SID enregistré dans state.json (LAPSManagedSIDs, compte créé ou
//     adopté par l'agent ≥ 2.15) : autorisé ;
//   - description = branding.LAPSAccountDescription : autorisé
//     (compatibilité : compte créé par un agent ≤ 2.14, qui posait cette
//     description à la création ; son SID est alors enregistré) ;
//   - tout autre compte existant : refusé.
func checkLAPSAccountManageable(username string, acct lapsAccount, managedSIDs []string) error {
	if err := checkLAPSUsernameAllowed(username); err != nil {
		return err
	}
	if !acct.Exists {
		return nil
	}
	rid, ok := localAccountRID(acct.SID)
	if !ok {
		return fmt.Errorf("SID inattendu pour un compte local : %q", acct.SID)
	}
	if rid < 1000 {
		return fmt.Errorf("compte intégré Windows (RID %d) : jamais géré par la LAPS", rid)
	}
	for _, s := range managedSIDs {
		if strings.EqualFold(s, acct.SID) {
			return nil
		}
	}
	want := strings.TrimSpace(branding.LAPSAccountDescription)
	if want != "" && strings.TrimSpace(acct.Description) == want {
		return nil
	}
	return fmt.Errorf("compte existant non créé par l'agent (description %q) : refusé", acct.Description)
}

// localAccountRID — RID d'un SID de compte local (S-1-5-21-x-y-z-RID).
func localAccountRID(sid string) (uint64, bool) {
	if !strings.HasPrefix(strings.ToUpper(sid), "S-1-5-21-") {
		return 0, false
	}
	i := strings.LastIndexByte(sid, '-')
	rid, err := strconv.ParseUint(sid[i+1:], 10, 32)
	if err != nil {
		return 0, false
	}
	return rid, true
}

// recordLAPSManagedSID — mémorise un compte créé/adopté par l'agent.
func recordLAPSManagedSID(st *State, sid string) {
	if sid == "" {
		return
	}
	for _, s := range st.LAPSManagedSIDs {
		if strings.EqualFold(s, sid) {
			return
		}
	}
	st.LAPSManagedSIDs = append(st.LAPSManagedSIDs, sid)
}

// fail — arme le backoff exponentiel après un échec.
func (r *lapsRotator) fail(st *State, now time.Time) {
	st.LAPSFailures++
	st.LAPSRetryAfter = now.Add(lapsBackoff(st.LAPSFailures))
}

func (r *lapsRotator) resetBackoff(st *State) {
	st.LAPSFailures = 0
	st.LAPSRetryAfter = time.Time{}
}

// lapsBackoff — 15 min, 30 min, 1 h, … plafonné à 24 h.
func lapsBackoff(failures int) time.Duration {
	d := lapsBackoffBase
	for i := 1; i < failures; i++ {
		d *= 2
		if d >= lapsBackoffMax {
			return lapsBackoffMax
		}
	}
	return d
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
	req.Header.Set("Authorization", "Bearer "+cfg.token())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent())

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP : %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return &escrowHTTPError{Status: resp.StatusCode}
	}
	return nil
}

// escrowHTTPError — réponse non-2xx de POST /api/agent/admin-credential.
type escrowHTTPError struct{ Status int }

func (e *escrowHTTPError) Error() string { return fmt.Sprintf("HTTP %d", e.Status) }

// isPermanentEscrowRejection — le serveur refuse ce contenu et le refusera
// toujours (400 ciphertext invalide, 403, 404…). 401 (token en cours de
// rotation), 408 et 429 (rate limit) restent transitoires, comme les 5xx
// et les erreurs réseau.
func isPermanentEscrowRejection(err error) bool {
	var he *escrowHTTPError
	if !errors.As(err, &he) {
		return false
	}
	switch he.Status {
	case http.StatusUnauthorized, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return false
	}
	return he.Status >= 400 && he.Status < 500
}
