//go:build !windows

package main

// Stub — restartService n'a pas de sens hors Windows. Présent pour permettre
// de compiler/tester l'agent localement.
func restartService() error {
	logf("restartService : no-op (build non-Windows)")
	return nil
}
