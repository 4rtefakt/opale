package main

import (
	"context"
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
