//go:build !windows

package main

import "context"

// Stubs non-Windows. L'exécution PowerShell n'a de sens que sur Windows ;
// permet de compiler/tester sur Mac.

func processCommands(ctx context.Context, cfg *Config, cmds []Command) {
	if len(cmds) > 0 {
		logf("processCommands : no-op (build non-Windows), %d commandes ignorées", len(cmds))
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
