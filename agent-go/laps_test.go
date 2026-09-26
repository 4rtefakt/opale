package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// --- Fakes ------------------------------------------------------------------

// lapsFake enregistre la séquence des appels (escrow / apply / save) pour
// vérifier l'ordre imposé par la machine à états.
type lapsFake struct {
	mu        sync.Mutex
	calls     []string
	escrowed  []string // "user:ciphertext" dans l'ordre des POST
	escrowErr []error  // erreurs à renvoyer, consommées dans l'ordre (nil = OK)
	applyRes  lapsApplyResult
	applied   []string // "user:password"
	modes     []string // "create" / "update:<sid>"
	account   lapsAccount
	lookupErr error
	saveErr   error
	saves     []State // copie du state à chaque save
	st        *State
	pwSeq     int
	now       time.Time
	username  string
}

func (f *lapsFake) record(c string) {
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
}

func (f *lapsFake) lookup(username string) (lapsAccount, error) {
	f.record("lookup")
	return f.account, f.lookupErr
}

func (f *lapsFake) apply(username, password string, acct lapsAccount) lapsApplyResult {
	f.record("apply")
	f.applied = append(f.applied, username+":"+password)
	if acct.Exists {
		f.modes = append(f.modes, "update:"+acct.SID)
	} else {
		f.modes = append(f.modes, "create")
	}
	return f.applyRes
}

func (f *lapsFake) rotator() *lapsRotator {
	return &lapsRotator{
		escrow: func(ctx context.Context, username string, enc []byte) error {
			f.record("escrow")
			f.escrowed = append(f.escrowed, username+":"+string(enc))
			if len(f.escrowErr) > 0 {
				err := f.escrowErr[0]
				f.escrowErr = f.escrowErr[1:]
				return err
			}
			return nil
		},
		accounts: f,
		// Chiffrement factice lisible : permet de relier escrow et apply.
		encrypt: func(plain string) ([]byte, error) { return []byte("enc(" + plain + ")"), nil },
		genPassword: func() (string, error) {
			f.pwSeq++
			return "pw" + string(rune('0'+f.pwSeq)), nil
		},
		save: func() error {
			f.record("save")
			if f.st != nil {
				cp := *f.st
				if f.st.PendingAdminCred != nil {
					p := *f.st.PendingAdminCred
					cp.PendingAdminCred = &p
				}
				f.saves = append(f.saves, cp)
			}
			return f.saveErr
		},
		now:      func() time.Time { return f.now },
		username: func() string { return f.username },
	}
}

func newLAPSFake(st *State) *lapsFake {
	return &lapsFake{
		st:       st,
		now:      time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC),
		username: "opale-recovery",
		applyRes: lapsApplyResult{Outcome: lapsSetOK, SID: "S-1-5-21-1-2-3-1001"},
	}
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func indexOf(calls []string, name string, nth int) int {
	seen := 0
	for i, c := range calls {
		if c == name {
			if seen == nth {
				return i
			}
			seen++
		}
	}
	return -1
}

// --- Ordre nominal ----------------------------------------------------------

// Le mot de passe est persisté (stash) PUIS escrowé PUIS appliqué
// localement ; le stash n'est effacé qu'après application réussie.
func TestLAPS_EscrowBeforeLocalSet(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.rotator().run(context.Background(), st)

	iSave := indexOf(f.calls, "save", 0)
	iEscrow := indexOf(f.calls, "escrow", 0)
	iApply := indexOf(f.calls, "apply", 0)
	if !(iSave >= 0 && iSave < iEscrow && iEscrow < iApply) {
		t.Fatalf("ordre attendu save < escrow < apply, reçu %v", f.calls)
	}
	if f.saves[0].PendingAdminCred == nil || f.saves[0].PendingAdminCred.Phase != lapsPhasePrepared {
		t.Fatalf("1er save : stash 'prepared' attendu, reçu %+v", f.saves[0].PendingAdminCred)
	}
	if got, want := f.escrowed[0], "opale-recovery:enc(pw1)"; got != want {
		t.Fatalf("escrow = %q, attendu %q", got, want)
	}
	if got, want := f.applied[0], "opale-recovery:pw1"; got != want {
		t.Fatalf("apply = %q, attendu %q (même mdp que l'escrow)", got, want)
	}
	if st.PendingAdminCred != nil {
		t.Fatalf("stash non effacé après succès : %+v", st.PendingAdminCred)
	}
	if !st.LastAdminRotation.Equal(f.now) {
		t.Fatalf("LastAdminRotation = %v, attendu %v", st.LastAdminRotation, f.now)
	}
	if st.CurrentAdminCred == nil || st.CurrentAdminCred.EncB64 != b64("enc(pw1)") {
		t.Fatalf("CurrentAdminCred = %+v", st.CurrentAdminCred)
	}
	last := f.saves[len(f.saves)-1]
	if last.PendingAdminCred != nil || last.LastAdminRotation.IsZero() {
		t.Fatalf("état final non persisté : %+v", last)
	}
}

func TestLAPS_NotDue_NoAction(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.LastAdminRotation = f.now.Add(-24 * time.Hour)
	f.rotator().run(context.Background(), st)
	if len(f.calls) != 0 {
		t.Fatalf("aucune action attendue avant l'échéance, reçu %v", f.calls)
	}
}

// --- Échecs avant l'application locale ---------------------------------------

func TestLAPS_StashSaveFailure_NoEscrowNoSet(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.saveErr = errors.New("disque plein")
	f.rotator().run(context.Background(), st)
	if indexOf(f.calls, "escrow", 0) >= 0 || indexOf(f.calls, "apply", 0) >= 0 {
		t.Fatalf("aucun escrow/apply sans stash persisté, reçu %v", f.calls)
	}
	if st.PendingAdminCred != nil {
		t.Fatalf("stash en mémoire non restauré : %+v", st.PendingAdminCred)
	}
	if st.LAPSRetryAfter.IsZero() {
		t.Fatal("backoff attendu après échec")
	}
}

func TestLAPS_EscrowFailure_LocalPasswordUntouched(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.escrowErr = []error{errors.New("HTTP 500")}
	f.rotator().run(context.Background(), st)
	if indexOf(f.calls, "apply", 0) >= 0 {
		t.Fatalf("apply ne doit pas être appelé si l'escrow échoue : %v", f.calls)
	}
	if st.PendingAdminCred == nil || st.PendingAdminCred.Phase != lapsPhasePrepared {
		t.Fatalf("stash 'prepared' attendu, reçu %+v", st.PendingAdminCred)
	}
	if !st.LastAdminRotation.IsZero() {
		t.Fatal("LastAdminRotation ne doit pas avancer")
	}
	if want := f.now.Add(lapsBackoffBase); !st.LAPSRetryAfter.Equal(want) {
		t.Fatalf("LAPSRetryAfter = %v, attendu %v", st.LAPSRetryAfter, want)
	}
}

// --- Échecs de l'application locale après escrow ------------------------------

// Mot de passe local inchangé : on réaligne le serveur sur le mot de passe
// en place (CurrentAdminCred) et le stash est effacé.
func TestLAPS_SetUnchanged_RestoresPreviousEscrow(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetUnchanged, Err: errors.New("politique de mdp")}
	f.rotator().run(context.Background(), st)

	if len(f.escrowed) != 2 || f.escrowed[0] != "opale-recovery:enc(pw1)" || f.escrowed[1] != "opale-recovery:enc(old)" {
		t.Fatalf("escrows attendus [nouveau, ancien], reçu %v", f.escrowed)
	}
	if st.PendingAdminCred != nil {
		t.Fatalf("stash doit être effacé après restauration : %+v", st.PendingAdminCred)
	}
	if st.CurrentAdminCred.EncB64 != b64("enc(old)") {
		t.Fatalf("CurrentAdminCred ne doit pas changer : %+v", st.CurrentAdminCred)
	}
	if !st.LastAdminRotation.IsZero() || st.LAPSRetryAfter.IsZero() {
		t.Fatalf("rotation à retenter après backoff : last=%v retry=%v", st.LastAdminRotation, st.LAPSRetryAfter)
	}
}

// Pas d'ancien ciphertext connu (1er cycle après mise à jour depuis 2.14) :
// impossible de restaurer → stash "escrowed" conservé → roll-forward.
func TestLAPS_SetUnchanged_NoPrevious_KeepsEscrowedStash(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetUnchanged, Err: errors.New("KO")}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 {
		t.Fatalf("un seul escrow attendu, reçu %v", f.escrowed)
	}
	if st.PendingAdminCred == nil || st.PendingAdminCred.Phase != lapsPhaseEscrowed {
		t.Fatalf("stash 'escrowed' attendu, reçu %+v", st.PendingAdminCred)
	}
}

// Issue incertaine : on ne restaure JAMAIS l'ancien escrow (il pourrait ne
// plus être le bon).
func TestLAPS_SetUncertain_NoRestore(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetUncertain, Err: errors.New("timeout")}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 {
		t.Fatalf("pas de restauration attendue, escrows : %v", f.escrowed)
	}
	if st.PendingAdminCred == nil || st.PendingAdminCred.Phase != lapsPhaseEscrowed {
		t.Fatalf("stash 'escrowed' attendu, reçu %+v", st.PendingAdminCred)
	}
}

// Mot de passe changé mais activation/groupe en échec : serveur et poste
// sont alignés → CurrentAdminCred mis à jour, rotation retentée plus tard.
func TestLAPS_ChangedPartial_RecordsCurrent(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetChangedPartial, Err: errors.New("groupe")}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 {
		t.Fatalf("pas de restauration attendue, escrows : %v", f.escrowed)
	}
	if st.CurrentAdminCred.EncB64 != b64("enc(pw1)") || st.PendingAdminCred != nil {
		t.Fatalf("état attendu aligné sur le nouveau mdp : cur=%+v pending=%+v", st.CurrentAdminCred, st.PendingAdminCred)
	}
	if !st.LastAdminRotation.IsZero() || st.LAPSRetryAfter.IsZero() {
		t.Fatal("rotation complète à retenter après backoff")
	}
}

// --- Reprise après crash / rotation interrompue --------------------------------

// Crash entre escrow et application (ou entre application et effacement du
// stash) : phase "escrowed" → nouvelle rotation immédiate même si
// l'intervalle n'est pas échu, sans restaurer l'ancien escrow.
func TestLAPS_EscrowedStashAfterCrash_RollsForward(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	st.LastAdminRotation = f.now.Add(-time.Hour) // pas échu
	st.PendingAdminCred = &PendingAdminCred{Username: "opale-recovery", EncB64: b64("enc(lost)"), StashedAt: f.now.Add(-time.Minute), Phase: lapsPhaseEscrowed}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 || f.escrowed[0] != "opale-recovery:enc(pw1)" {
		t.Fatalf("roll-forward attendu sans restauration, escrows : %v", f.escrowed)
	}
	if st.PendingAdminCred != nil || st.CurrentAdminCred.EncB64 != b64("enc(pw1)") {
		t.Fatalf("rotation complète attendue : %+v / %+v", st.PendingAdminCred, st.CurrentAdminCred)
	}
}

// Phase "prepared" après redémarrage : le poste a toujours l'ancien mdp ;
// le serveur est réaligné dessus avant la nouvelle rotation.
func TestLAPS_PreparedStashAfterRestart_RestoresThenRollsForward(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	st.LastAdminRotation = f.now.Add(-time.Hour)
	st.PendingAdminCred = &PendingAdminCred{Username: "opale-recovery", EncB64: b64("enc(unsent)"), StashedAt: f.now.Add(-time.Minute), Phase: lapsPhasePrepared}
	f.rotator().run(context.Background(), st)
	want := []string{"opale-recovery:enc(old)", "opale-recovery:enc(pw1)"}
	if strings.Join(f.escrowed, ",") != strings.Join(want, ",") {
		t.Fatalf("escrows = %v, attendu %v", f.escrowed, want)
	}
	if st.PendingAdminCred != nil {
		t.Fatalf("stash non effacé : %+v", st.PendingAdminCred)
	}
}

func TestLAPS_BackoffRespected(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.LAPSRetryAfter = f.now.Add(time.Minute)
	f.rotator().run(context.Background(), st)
	if len(f.calls) != 0 {
		t.Fatalf("aucune action pendant le backoff, reçu %v", f.calls)
	}
}

// Échéance de backoff aberrante (horloge corrigée en arrière) : ignorée.
func TestLAPS_BackoffBeyondMaxIgnored(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.LAPSRetryAfter = f.now.Add(30 * 24 * time.Hour)
	f.rotator().run(context.Background(), st)
	if indexOf(f.calls, "apply", 0) < 0 {
		t.Fatalf("rotation attendue malgré un backoff aberrant, reçu %v", f.calls)
	}
}

func TestLAPSBackoff_Schedule(t *testing.T) {
	cases := map[int]time.Duration{
		1: 15 * time.Minute, 2: 30 * time.Minute, 3: time.Hour, 7: 16 * time.Hour, 8: 24 * time.Hour, 50: 24 * time.Hour,
	}
	for n, want := range cases {
		if got := lapsBackoff(n); got != want {
			t.Errorf("lapsBackoff(%d) = %v, attendu %v", n, got, want)
		}
	}
}

// --- Stash legacy (agent ≤ 2.14 : mdp appliqué, POST échoué) --------------------

func TestLAPS_LegacyStashResentBeforeRotation(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.PendingAdminCred = &PendingAdminCred{Username: "old-user", EncB64: b64("enc(live)"), StashedAt: f.now.Add(-48 * time.Hour)}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 || f.escrowed[0] != "old-user:enc(live)" {
		t.Fatalf("renvoi du stash legacy attendu, escrows : %v", f.escrowed)
	}
	if indexOf(f.calls, "apply", 0) >= 0 {
		t.Fatalf("pas de rotation dans le même cycle : %v", f.calls)
	}
	if st.PendingAdminCred != nil || st.CurrentAdminCred == nil || st.CurrentAdminCred.Username != "old-user" {
		t.Fatalf("stash non soldé : pending=%+v cur=%+v", st.PendingAdminCred, st.CurrentAdminCred)
	}
	if !st.LastAdminRotation.Equal(f.now) {
		t.Fatalf("LastAdminRotation = %v", st.LastAdminRotation)
	}
}

func TestLAPS_LegacyStashResendFailure_BlocksRotation(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.escrowErr = []error{errors.New("HTTP 503")}
	st.PendingAdminCred = &PendingAdminCred{Username: "old-user", EncB64: b64("enc(live)"), StashedAt: f.now.Add(-48 * time.Hour)}
	f.rotator().run(context.Background(), st)
	if indexOf(f.calls, "apply", 0) >= 0 || len(f.escrowed) != 1 {
		t.Fatalf("aucune rotation tant que le stash legacy n'est pas escrowé : %v", f.calls)
	}
	if st.PendingAdminCred == nil || st.PendingAdminCred.Phase != "" {
		t.Fatalf("stash legacy doit être conservé : %+v", st.PendingAdminCred)
	}
}

// Stash legacy antérieur à une rotation escrowée avec succès : périmé, le
// renvoyer écraserait le bon mot de passe côté serveur.
func TestLAPS_StaleLegacyStashDiscarded(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.LastAdminRotation = f.now.Add(-time.Hour)
	st.PendingAdminCred = &PendingAdminCred{Username: "old-user", EncB64: b64("enc(stale)"), StashedAt: f.now.Add(-48 * time.Hour)}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 0 {
		t.Fatalf("stash périmé ne doit pas être envoyé : %v", f.escrowed)
	}
	if st.PendingAdminCred != nil {
		t.Fatal("stash périmé doit être supprimé")
	}
}

// Hors Windows (pas de comptes gérés) : jamais de rotation ni d'escrow.
func TestLAPS_NoAccountStore_NoRotation(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	r := f.rotator()
	r.accounts = nil
	r.run(context.Background(), st)
	if len(f.escrowed) != 0 {
		t.Fatalf("aucun escrow attendu sans comptes locaux : %v", f.escrowed)
	}
}

// --- Interprétation du script PowerShell ----------------------------------------

func TestClassifyLAPSApplyExit(t *testing.T) {
	cases := []struct {
		started, timedOut bool
		code              int
		want              lapsSetOutcome
	}{
		{false, false, -1, lapsSetUnchanged},
		{true, false, 0, lapsSetOK},
		{true, false, 10, lapsSetUnchanged},
		{true, false, 11, lapsSetUnchanged},
		{true, false, 12, lapsSetChangedPartial},
		{true, false, 1, lapsSetUncertain},
		{true, true, 0, lapsSetUncertain},
		{true, true, 1, lapsSetUncertain},
	}
	for _, c := range cases {
		if got := classifyLAPSApplyExit(c.started, c.code, c.timedOut); got != c.want {
			t.Errorf("classify(started=%v code=%d timeout=%v) = %v, attendu %v", c.started, c.code, c.timedOut, got, c.want)
		}
	}
}

func TestLAPSExitStatus(t *testing.T) {
	requireSh(t)
	run := func(script string) (error, *os.ProcessState) {
		cmd := exec.Command("sh", "-c", script)
		err := cmd.Run()
		return err, cmd.ProcessState
	}
	okErr, okPS := run("exit 0")
	failErr, failPS := run("exit 11")

	if code, to := lapsExitStatus(okErr, okPS, nil); code != 0 || to {
		t.Fatalf("succès : code=%d timeout=%v", code, to)
	}
	// Sorti seul avec 0 pile à l'échéance : pas un timeout.
	if code, to := lapsExitStatus(nil, okPS, context.DeadlineExceeded); code != 0 || to {
		t.Fatalf("succès à l'échéance : code=%d timeout=%v", code, to)
	}
	// Pipes gardés par un sous-process : le statut de succès fait foi.
	if code, to := lapsExitStatus(exec.ErrWaitDelay, okPS, nil); code != 0 || to {
		t.Fatalf("ErrWaitDelay : code=%d timeout=%v", code, to)
	}
	if code, to := lapsExitStatus(failErr, failPS, nil); code != 11 || to {
		t.Fatalf("exit 11 : code=%d timeout=%v", code, to)
	}
	// Tué par l'échéance : timeout (issue incertaine).
	if _, to := lapsExitStatus(failErr, failPS, context.DeadlineExceeded); !to {
		t.Fatal("process en erreur après l'échéance : timeout attendu")
	}
}

// Le SID doit sortir dès que le mot de passe est en place, avant les
// étapes qui peuvent échouer (exit 12) : sinon un compte créé par l'agent
// n'est pas mémorisé dans LAPSManagedSIDs.
func TestLAPSApplyScript_SIDBeforePostSteps(t *testing.T) {
	iSID := strings.Index(lapsApplyScript, "'SID='")
	iEnable := strings.Index(lapsApplyScript, "Enable-LocalUser")
	// Mode update : le mot de passe est changé sur le SID vérifié (pas sur
	// le nom, qui pourrait avoir été réattribué entre le contrôle et l'action).
	iSet := strings.Index(lapsApplyScript, "Set-LocalUser -SID $expectedSid -Password")
	if iSID < 0 || iEnable < 0 || iSet < 0 || !(iSet < iSID && iSID < iEnable) {
		t.Fatalf("ordre attendu Set-LocalUser < SID= < Enable-LocalUser (set=%d sid=%d enable=%d)", iSet, iSID, iEnable)
	}
}

func TestLAPS_ChangedPartial_RecordsCreatedSID(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetChangedPartial, SID: "S-1-5-21-1-2-3-1010", Err: errors.New("groupe")}
	f.rotator().run(context.Background(), st)
	if len(st.LAPSManagedSIDs) != 1 || st.LAPSManagedSIDs[0] != "S-1-5-21-1-2-3-1010" {
		t.Fatalf("compte créé non mémorisé après échec partiel : %v", st.LAPSManagedSIDs)
	}
}

func TestParseLAPSSID(t *testing.T) {
	if got := parseLAPSSID("noise\r\nSID=S-1-5-21-1-2-3-1001\r\n"); got != "S-1-5-21-1-2-3-1001" {
		t.Fatalf("got %q", got)
	}
	if got := parseLAPSSID("rien"); got != "" {
		t.Fatalf("got %q", got)
	}
}

// --- Bout en bout via MaybeRotateAdminPassword --------------------------------

// Un stash écrit par un agent ≤ 2.14 (mdp déjà appliqué, POST échoué) doit
// être renvoyé tel quel au serveur, au format historique du POST.
func TestMaybeRotateAdminPassword_ResendsLegacyStash(t *testing.T) {
	if lapsPubKey == nil {
		t.Skip("clé publique LAPS absente")
	}
	t.Setenv("RMM_DATA_DIR", t.TempDir())
	var mu sync.Mutex
	var bodies []map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/admin-credential" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "unexpected", http.StatusNotFound)
			return
		}
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	cfg := &Config{Token: "tok", URL: srv.URL, LAPSEnabled: true}
	stashed := time.Now().UTC().Add(-2 * time.Hour)
	st := &State{
		LastAdminRotation: time.Now().UTC().Add(-40 * 24 * time.Hour),
		PendingAdminCred:  &PendingAdminCred{Username: "opale-recovery", EncB64: b64("ciphertext-2.14"), StashedAt: stashed},
	}
	MaybeRotateAdminPassword(context.Background(), cfg, st)

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("stash legacy jamais renvoyé : %d POST admin-credential", len(bodies))
	}
	if bodies[0]["username"] != "opale-recovery" || bodies[0]["encrypted_password"] != b64("ciphertext-2.14") {
		t.Fatalf("corps POST inattendu : %v", bodies[0])
	}
	if st.PendingAdminCred != nil {
		t.Fatalf("stash non effacé : %+v", st.PendingAdminCred)
	}
}

// --- Règle « compte créé par l'agent » -----------------------------------------

func TestCheckLAPSAccountManageable(t *testing.T) {
	marker := branding.LAPSAccountDescription
	const sidUser = "S-1-5-21-111-222-333-1001"
	cases := []struct {
		name    string
		user    string
		acct    lapsAccount
		managed []string
		ok      bool
	}{
		{"absent → création", "opale-recovery", lapsAccount{}, nil, true},
		{"nom sensible", "Administrator", lapsAccount{}, nil, false},
		{"RID 500 renommé, même avec la description", "opale-recovery", lapsAccount{Exists: true, SID: "S-1-5-21-111-222-333-500", Description: marker}, nil, false},
		{"Invité RID 501", "opale-recovery", lapsAccount{Exists: true, SID: "S-1-5-21-111-222-333-501", Description: marker}, nil, false},
		{"WDAGUtilityAccount RID 504", "opale-recovery", lapsAccount{Exists: true, SID: "S-1-5-21-111-222-333-504"}, []string{"S-1-5-21-111-222-333-504"}, false},
		{"compte utilisateur existant", "jdupont", lapsAccount{Exists: true, SID: sidUser, Description: "Jean Dupont"}, nil, false},
		{"compte existant sans description", "opale-recovery", lapsAccount{Exists: true, SID: sidUser}, nil, false},
		{"créé par agent ≤ 2.14 (description)", "opale-recovery", lapsAccount{Exists: true, SID: sidUser, Description: marker}, nil, true},
		{"SID enregistré (description modifiée)", "opale-recovery", lapsAccount{Exists: true, SID: sidUser, Description: "autre"}, []string{sidUser}, true},
		{"SID hors domaine local", "opale-recovery", lapsAccount{Exists: true, SID: "S-1-5-18", Description: marker}, nil, false},
		{"SID illisible", "opale-recovery", lapsAccount{Exists: true, SID: "garbage", Description: marker}, nil, false},
	}
	for _, c := range cases {
		err := checkLAPSAccountManageable(c.user, c.acct, c.managed)
		if (err == nil) != c.ok {
			t.Errorf("%s : err=%v, attendu ok=%v", c.name, err, c.ok)
		}
	}
}

// Le serveur pointe la LAPS sur un compte existant que l'agent n'a pas
// créé : ni escrow (qui écraserait le bon mot de passe), ni application.
func TestLAPS_RefusesUnmanagedExistingAccount(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.username = "jdupont"
	f.account = lapsAccount{Exists: true, SID: "S-1-5-21-1-2-3-1105", Description: "Jean Dupont"}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 0 || len(f.applied) != 0 {
		t.Fatalf("aucun escrow/apply attendu : escrows=%v applied=%v", f.escrowed, f.applied)
	}
	if st.LAPSRetryAfter.IsZero() {
		t.Fatal("backoff attendu")
	}
}

func TestLAPS_RefusesBuiltinAdministrator(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.account = lapsAccount{Exists: true, SID: "S-1-5-21-1-2-3-500", Description: branding.LAPSAccountDescription}
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 0 || len(f.applied) != 0 {
		t.Fatalf("RID 500 ne doit jamais être géré : escrows=%v applied=%v", f.escrowed, f.applied)
	}
}

func TestLAPS_LookupFailure_NoEscrow(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.lookupErr = errors.New("PowerShell absent")
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 0 {
		t.Fatalf("aucun escrow sans lookup : %v", f.escrowed)
	}
}

// Compatibilité flotte : compte créé par un agent ≤ 2.14 (description
// branding) → adopté, mis à jour en mode "update" sur son SID, SID mémorisé.
func TestLAPS_AdoptsLegacyAccountByDescription(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.account = lapsAccount{Exists: true, SID: "S-1-5-21-1-2-3-1001", Description: branding.LAPSAccountDescription}
	f.applyRes = lapsApplyResult{Outcome: lapsSetOK, SID: "S-1-5-21-1-2-3-1001"}
	f.rotator().run(context.Background(), st)
	if len(f.modes) != 1 || f.modes[0] != "update:S-1-5-21-1-2-3-1001" {
		t.Fatalf("mode attendu update sur le SID vérifié, reçu %v", f.modes)
	}
	if len(st.LAPSManagedSIDs) != 1 || st.LAPSManagedSIDs[0] != "S-1-5-21-1-2-3-1001" {
		t.Fatalf("SID non mémorisé : %v", st.LAPSManagedSIDs)
	}
}

func TestLAPS_CreatesMissingAccountAndRecordsSID(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	f.applyRes = lapsApplyResult{Outcome: lapsSetOK, SID: "S-1-5-21-1-2-3-1007"}
	f.rotator().run(context.Background(), st)
	if len(f.modes) != 1 || f.modes[0] != "create" {
		t.Fatalf("mode create attendu, reçu %v", f.modes)
	}
	if len(st.LAPSManagedSIDs) != 1 || st.LAPSManagedSIDs[0] != "S-1-5-21-1-2-3-1007" {
		t.Fatalf("SID non mémorisé : %v", st.LAPSManagedSIDs)
	}
	// Rotation suivante : compte existant, description effacée par un
	// admin, mais SID mémorisé → toujours géré.
	st.LastAdminRotation = f.now.Add(-LAPSRotationInterval)
	f.account = lapsAccount{Exists: true, SID: "S-1-5-21-1-2-3-1007", Description: ""}
	f.rotator().run(context.Background(), st)
	if len(f.modes) != 2 || f.modes[1] != "update:S-1-5-21-1-2-3-1007" {
		t.Fatalf("2e rotation attendue en update, reçu %v", f.modes)
	}
	if len(st.LAPSManagedSIDs) != 1 {
		t.Fatalf("SID dupliqué : %v", st.LAPSManagedSIDs)
	}
}

func TestParseLAPSLookup(t *testing.T) {
	if a, err := parseLAPSLookup("", lapsExitNotFound); err != nil || a.Exists {
		t.Fatalf("absent : %+v %v", a, err)
	}
	desc := "Compte de récupération Opale"
	out := "SID=S-1-5-21-1-2-3-1001\r\nDESC64=" + base64.StdEncoding.EncodeToString([]byte(desc)) + "\r\n"
	a, err := parseLAPSLookup(out, lapsExitOK)
	if err != nil || !a.Exists || a.SID != "S-1-5-21-1-2-3-1001" || a.Description != desc {
		t.Fatalf("parse : %+v %v", a, err)
	}
	if _, err := parseLAPSLookup("", 1); err == nil {
		t.Fatal("exit 1 doit être une erreur (pas « compte absent »)")
	}
	if _, err := parseLAPSLookup("DESC64=", lapsExitOK); err == nil {
		t.Fatal("SID manquant doit être une erreur")
	}
}

// Stash legacy refusé définitivement par le serveur (4xx hors 401/408/429) :
// abandonné, puis rotation complète (escrow d'abord) dans le même cycle —
// sinon la LAPS resterait bloquée indéfiniment.
func TestLAPS_LegacyStashPermanentlyRejected_DroppedThenRotates(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	st.LastAdminRotation = f.now.Add(-time.Hour) // pas échu : la rotation est forcée
	st.PendingAdminCred = &PendingAdminCred{Username: "opale-recovery", EncB64: b64("enc(live)"), StashedAt: f.now.Add(-30 * time.Minute)}
	f.escrowErr = []error{&escrowHTTPError{Status: 400}}
	f.rotator().run(context.Background(), st)

	want := []string{"opale-recovery:enc(live)", "opale-recovery:enc(pw1)"}
	if strings.Join(f.escrowed, ",") != strings.Join(want, ",") {
		t.Fatalf("escrows = %v, attendu %v", f.escrowed, want)
	}
	if len(f.applied) != 1 || st.PendingAdminCred != nil || st.CurrentAdminCred == nil || st.CurrentAdminCred.EncB64 != b64("enc(pw1)") {
		t.Fatalf("rotation complète attendue : applied=%v pending=%+v cur=%+v", f.applied, st.PendingAdminCred, st.CurrentAdminCred)
	}
}

// Refus transitoires (401 token en rotation, 429 rate limit, 5xx) : le
// stash legacy est conservé et aucune rotation n'a lieu.
func TestLAPS_LegacyStashTransientRejection_Kept(t *testing.T) {
	for _, status := range []int{401, 408, 429, 500, 503} {
		st := &State{}
		f := newLAPSFake(st)
		st.PendingAdminCred = &PendingAdminCred{Username: "opale-recovery", EncB64: b64("enc(live)"), StashedAt: f.now.Add(-time.Hour)}
		f.escrowErr = []error{&escrowHTTPError{Status: status}}
		f.rotator().run(context.Background(), st)
		if st.PendingAdminCred == nil || len(f.applied) != 0 || len(f.escrowed) != 1 {
			t.Errorf("HTTP %d : stash conservé sans rotation attendu (pending=%+v applied=%v)", status, st.PendingAdminCred, f.applied)
		}
	}
}

func TestIsPermanentEscrowRejection(t *testing.T) {
	cases := map[error]bool{
		&escrowHTTPError{Status: 400}:          true,
		&escrowHTTPError{Status: 403}:          true,
		&escrowHTTPError{Status: 404}:          true,
		&escrowHTTPError{Status: 401}:          false,
		&escrowHTTPError{Status: 408}:          false,
		&escrowHTTPError{Status: 429}:          false,
		&escrowHTTPError{Status: 500}:          false,
		errors.New("HTTP : dial tcp: refused"): false,
	}
	for err, want := range cases {
		if got := isPermanentEscrowRejection(err); got != want {
			t.Errorf("%v : %v, attendu %v", err, got, want)
		}
	}
}

// postAdminCredential expose le statut HTTP (format du POST inchangé).
func TestPostAdminCredential_ReturnsHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"taille du ciphertext suspecte"}`, http.StatusBadRequest)
	}))
	defer srv.Close()
	err := postAdminCredential(context.Background(), &Config{Token: "t", URL: srv.URL}, "u", []byte("x"))
	if !isPermanentEscrowRejection(err) || err.Error() != "HTTP 400" {
		t.Fatalf("attendu un refus définitif « HTTP 400 », reçu %v", err)
	}
}

// La phase "escrowed" doit être persistée avant l'application locale : si
// l'écriture échoue, on n'applique pas (sur disque, "prepared" reste vrai :
// mot de passe jamais appliqué).
func TestLAPS_EscrowedPhaseMustBePersistedBeforeApply(t *testing.T) {
	st := &State{}
	f := newLAPSFake(st)
	r := f.rotator()
	saves := 0
	r.save = func() error {
		saves++
		if saves == 2 { // 1 = stash prepared, 2 = phase escrowed
			return errors.New("disque plein")
		}
		return nil
	}
	r.run(context.Background(), st)
	if len(f.escrowed) != 1 || len(f.applied) != 0 {
		t.Fatalf("pas d'application sans phase escrowed persistée : escrows=%v applied=%v", f.escrowed, f.applied)
	}
}

// Stash "prepared" réaligné avec succès puis compte refusé : le stash est
// soldé, le cycle suivant ne renvoie pas une nouvelle restauration.
func TestLAPS_PreparedStashClearedAfterRestore(t *testing.T) {
	st := &State{CurrentAdminCred: &AdminCredRecord{Username: "opale-recovery", EncB64: b64("enc(old)")}}
	f := newLAPSFake(st)
	st.PendingAdminCred = &PendingAdminCred{Username: "opale-recovery", EncB64: b64("enc(unsent)"), StashedAt: f.now.Add(-time.Minute), Phase: lapsPhasePrepared}
	f.account = lapsAccount{Exists: true, SID: "S-1-5-21-1-2-3-500"} // refusé
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 || f.escrowed[0] != "opale-recovery:enc(old)" || st.PendingAdminCred != nil {
		t.Fatalf("restauration unique + stash soldé attendus : escrows=%v pending=%+v", f.escrowed, st.PendingAdminCred)
	}
	f.now = st.LAPSRetryAfter.Add(time.Second)
	f.rotator().run(context.Background(), st)
	if len(f.escrowed) != 1 {
		t.Fatalf("nouvelle restauration inutile au cycle suivant : %v", f.escrowed)
	}
}
