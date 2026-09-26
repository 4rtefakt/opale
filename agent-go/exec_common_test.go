package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func requireSh(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("tests basés sur /bin/sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh absent")
	}
}

// Un script qui dépasse son timeout doit être rapporté comme tel (124 +
// mention), pas comme le code de sortie du process tué.
func TestRunWithTimeout_ReportsTimeout(t *testing.T) {
	requireSh(t)
	code, out := runWithTimeout(context.Background(), 200*time.Millisecond, nil, "sh", "-c", "echo debut; exec sleep 3")
	if code != execTimeoutExitCode {
		t.Fatalf("code = %d, attendu %d (sortie %q)", code, execTimeoutExitCode, out)
	}
	if !strings.Contains(out, "debut") || !strings.Contains(out, "[timeout après 200ms]") {
		t.Fatalf("sortie inattendue : %q", out)
	}
}

// Un sous-process d'arrière-plan qui hérite de stdout ne doit pas bloquer
// le checkin : sans WaitDelay, CombinedOutput attendait sa fin.
func TestRunWithTimeout_BackgroundChildDoesNotBlock(t *testing.T) {
	requireSh(t)
	orig := execWaitDelay
	execWaitDelay = 200 * time.Millisecond
	defer func() { execWaitDelay = orig }()

	start := time.Now()
	code, out := runWithTimeout(context.Background(), time.Minute, nil, "sh", "-c", "sleep 3 & echo fini")
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("bloqué %v par le sous-process d'arrière-plan", d)
	}
	if code != 0 || !strings.Contains(out, "fini") {
		t.Fatalf("code=%d sortie=%q", code, out)
	}
}

// Timeout + sous-process qui garde le pipe : retour borné par
// timeout + WaitDelay, toujours rapporté en timeout.
func TestRunWithTimeout_TimeoutWithBackgroundChild(t *testing.T) {
	requireSh(t)
	orig := execWaitDelay
	execWaitDelay = 200 * time.Millisecond
	defer func() { execWaitDelay = orig }()

	start := time.Now()
	code, out := runWithTimeout(context.Background(), 200*time.Millisecond, nil, "sh", "-c", "sleep 3 & sleep 3")
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("timeout non respecté : %v", d)
	}
	if code != execTimeoutExitCode {
		t.Fatalf("code = %d, attendu %d (sortie %q)", code, execTimeoutExitCode, out)
	}
}

func TestRunWithTimeout_ExitCodeAndParentCancel(t *testing.T) {
	requireSh(t)
	if code, _ := runWithTimeout(context.Background(), time.Minute, nil, "sh", "-c", "exit 7"); code != 7 {
		t.Fatalf("code = %d, attendu 7", code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	code, out := runWithTimeout(ctx, time.Minute, nil, "sh", "-c", "exec sleep 3")
	if code != 1 || !strings.Contains(out, "[interrompu : arrêt de l'agent]") {
		t.Fatalf("annulation parent : code=%d sortie=%q", code, out)
	}
	if code, out := runWithTimeout(context.Background(), time.Minute, nil, "/nonexistent-binary"); code != 1 || !strings.Contains(out, "error : ") {
		t.Fatalf("échec de démarrage : code=%d sortie=%q", code, out)
	}
}

// ErrWaitDelay signifie « sorti seul avec succès » : même si le contexte
// est terminé entre-temps, ce n'est ni un timeout ni une interruption.
func TestClassifyExecResult_WaitDelayWins(t *testing.T) {
	requireSh(t)
	cmd := exec.Command("sh", "-c", "exit 0")
	_ = cmd.Run()
	code, note := classifyExecResult(exec.ErrWaitDelay, cmd.ProcessState, context.DeadlineExceeded, context.Canceled, time.Minute)
	if code != 0 || !strings.Contains(note, "sortie tronquée") {
		t.Fatalf("code=%d note=%q", code, note)
	}
}

// Détection post-install : le résultat porte l'id du PACKAGE reçu dans la
// réponse du checkin (UUID distinct de celui du déploiement), jamais celui
// du déploiement (refusé par la clé étrangère device_software → packages).
func TestPostInstallDetection_ReportsPackageID(t *testing.T) {
	const depID = "11111111-1111-4111-8111-111111111111"
	const pkgID = "22222222-2222-4222-8222-222222222222"
	raw := `{"ok":true,"deployments":[{"deployment_id":"` + depID + `","package_id":"` + pkgID +
		`","name":"Pkg","type":"script","install_script":"x","detection_script":"exit 0"}]}`
	var resp CheckinResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	d := resp.Deployments[0]
	var ran []string
	exitCode := 0
	run := func(_ context.Context, script string) (int, string) {
		ran = append(ran, script)
		return exitCode, ""
	}

	got, ok := postInstallDetection(context.Background(), d, run)
	if !ok || got.PackageID != pkgID || !got.Detected {
		t.Fatalf("attendu {%s, détecté}, reçu %+v (ok=%v)", pkgID, got, ok)
	}
	exitCode = 1
	if got, _ := postInstallDetection(context.Background(), d, run); got.PackageID != pkgID || got.Detected {
		t.Fatalf("exit 1 : attendu {%s, non détecté}, reçu %+v", pkgID, got)
	}

	// Serveur sans package_id : aucun résultat (l'id du déploiement n'est
	// pas un id de package), script non exécuté.
	d.PackageID = ""
	if got, ok := postInstallDetection(context.Background(), d, run); ok {
		t.Fatalf("sans package_id : aucun résultat attendu, reçu %+v", got)
	}
	// Pas de detection_script : rien.
	if _, ok := postInstallDetection(context.Background(), Deployment{DeploymentID: depID, PackageID: pkgID}, run); ok {
		t.Fatal("sans detection_script : aucun résultat attendu")
	}
	if len(ran) != 2 {
		t.Fatalf("detection_script exécuté %d fois, attendu 2", len(ran))
	}
}

// Le jeton de réservation reçu avec un déploiement repart tel quel avec son
// résultat (le serveur n'applique ainsi un résultat qu'à la tentative qui
// l'a produit) ; sans jeton (serveur plus ancien), le champ est omis et un
// state.json d'avant 2.15.1 se relit.
func TestDeploymentResult_EchoesClaimToken(t *testing.T) {
	var resp CheckinResponse
	raw := `{"ok":true,"deployments":[{"deployment_id":"dep-1","claim_token":"1790000000123456","type":"script"}]}`
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(deploymentResult(resp.Deployments[0], 0, "ok"))
	if !strings.Contains(string(out), `"claim_token":"1790000000123456"`) {
		t.Fatalf("jeton non renvoyé : %s", out)
	}

	out, _ = json.Marshal(deploymentResult(Deployment{DeploymentID: "dep-2"}, 1, "ko"))
	if strings.Contains(string(out), "claim_token") {
		t.Fatalf("jeton vide envoyé : %s", out)
	}

	var st State
	if err := json.Unmarshal([]byte(`{"pending_deployments":[{"deployment_id":"dep-3","exit_code":0,"output":"ok"}]}`), &st); err != nil ||
		len(st.PendingDeployments) != 1 || st.PendingDeployments[0].ClaimToken != "" {
		t.Fatalf("state.json 2.14 illisible : %+v (%v)", st, err)
	}
}
