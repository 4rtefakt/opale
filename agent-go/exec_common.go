package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// execWaitDelay — après la fin (ou l'annulation) du process, délai maximal
// d'attente de la fermeture de ses pipes stdout/stderr. Sans lui, un
// sous-process lancé en arrière-plan par le script (qui hérite des pipes)
// bloquait CombinedOutput — et donc le checkin — indéfiniment, timeout
// compris. Variable pour les tests.
var execWaitDelay = 10 * time.Second

// execTimeoutExitCode — convention Unix timeout(1) ; l'API ne fait que le
// stocker.
const execTimeoutExitCode = 124

// runWithTimeout exécute name/args avec un timeout propre au script,
// capture stdout+stderr et retourne (code de sortie, sortie). prepare
// permet à la couche OS de régler SysProcAttr (fenêtre masquée…).
func runWithTimeout(parent context.Context, timeout time.Duration, prepare func(*exec.Cmd), name string, args ...string) (int, string) {
	c, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	cmd.WaitDelay = execWaitDelay
	if prepare != nil {
		prepare(cmd)
	}
	out, err := cmd.CombinedOutput()
	code, suffix := classifyExecResult(err, cmd.ProcessState, c.Err(), parent.Err(), timeout)
	res := string(out)
	if suffix != "" {
		res += "\n" + suffix
	}
	return code, strings.TrimSpace(res)
}

// classifyExecResult — code de sortie et mention à ajouter à la sortie.
// L'ordre compte : un process tué par le timeout remonte aussi une
// *exec.ExitError, qu'il ne faut pas confondre avec une sortie normale.
func classifyExecResult(err error, ps *os.ProcessState, runCtxErr, parentErr error, timeout time.Duration) (int, string) {
	if err == nil {
		return 0, ""
	}
	switch {
	case errors.Is(err, exec.ErrWaitDelay):
		// Le script est sorti seul avec succès (ErrWaitDelay n'est renvoyé
		// que dans ce cas) mais un sous-process garde ses pipes ouverts.
		code := 0
		if ps != nil {
			code = ps.ExitCode()
		}
		return code, "[sortie tronquée : un sous-process garde la sortie ouverte]"
	case parentErr != nil:
		// Arrêt de l'agent (service stoppé) : le script a été interrompu.
		return 1, "[interrompu : arrêt de l'agent]"
	case errors.Is(runCtxErr, context.DeadlineExceeded):
		return execTimeoutExitCode, "[timeout après " + timeout.String() + "]"
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), ""
	}
	return 1, "error : " + err.Error()
}

// resultSink — reçoit chaque résultat de déploiement (puis sa détection
// post-install) dès qu'il est connu. L'appelant le met en file et le
// persiste aussitôt : un crash, une coupure ou un installeur qui tue
// l'agent en cours de lot ne perd pas les résultats déjà obtenus (sinon
// timeout côté serveur et réinstallation au « Rejouer »).
type resultSink struct {
	deployment func(DeploymentResult)
	detection  func(DetectionResult)
}

// eachDeployment appelle run pour chaque déploiement du lot, dans l'ordre,
// et s'arrête à l'arrêt de l'agent (ctx annulé) : les suivants ne démarrent
// pas — réservés côté serveur, ils relèvent du timeout — au lieu d'être
// remontés en échec « interrompu » sans avoir tourné.
func eachDeployment(ctx context.Context, deps []Deployment, run func(Deployment)) {
	for i, d := range deps {
		if ctx.Err() != nil {
			logWarn("deployments-skipped", "arrêt de l'agent", LogFields{"skipped": len(deps) - i})
			return
		}
		run(d)
	}
}

// deploymentResult — résultat d'un déploiement, avec le jeton de
// réservation reçu du serveur (renvoyé tel quel).
func deploymentResult(d Deployment, exitCode int, output string) DeploymentResult {
	return DeploymentResult{
		DeploymentID: d.DeploymentID,
		ClaimToken:   d.ClaimToken,
		ExitCode:     exitCode,
		Output:       output,
	}
}

// postInstallDetection exécute via run le detection_script d'un déploiement
// (exit 0 = installé) et rattache le résultat au package déployé. Sans
// package_id (serveur antérieur à 2.15.1) : aucun résultat — l'id du
// déploiement n'est pas un id de package ; la détection périodique prend
// le relais.
func postInstallDetection(ctx context.Context, d Deployment, run func(context.Context, string) (int, string)) (DetectionResult, bool) {
	if d.DetectionScript == "" || d.PackageID == "" {
		return DetectionResult{}, false
	}
	detExit, _ := run(ctx, d.DetectionScript)
	return DetectionResult{
		PackageID: d.PackageID,
		Detected:  detExit == 0,
	}, true
}
