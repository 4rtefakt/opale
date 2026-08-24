//go:build !windows

package main

import (
	"context"
	"runtime"
)

// Stubs non-Windows. L'exécution PowerShell n'a de sens que sur Windows ;
// permet de compiler/tester sur Mac.

func processCommands(ctx context.Context, cfg *Config, cmds []Command) {
	// On POSTe un résultat "non supporté" plutôt que d'avaler silencieusement
	// la commande : sans ça, la row script_executions restait 'running'
	// pour toujours côté serveur.
	for _, cmd := range cmds {
		logf("processCommands : plateforme non supportée, échec explicite (id=%s)", cmd.ID)
		if err := postCommandResult(ctx, cfg, cmd.ID, 1,
			"exécution de scripts non supportée sur cette plateforme (build "+runtime.GOOS+")"); err != nil {
			logf("processCommands : POST résultat échoué : %v", err)
		}
	}
}

func processDeployments(ctx context.Context, deps []Deployment) ([]DeploymentResult, []DetectionResult) {
	if len(deps) > 0 {
		logf("processDeployments : no-op (build non-Windows), %d déploiements ignorés", len(deps))
	}
	return nil, nil
}

func processDetect(ctx context.Context, dets []Detect) []DetectionResult {
	if len(dets) > 0 {
		logf("processDetect : no-op (build non-Windows), %d détections ignorées", len(dets))
	}
	return nil
}
