//go:build !windows && !linux && !darwin

package main

// Stub pour OS non supportés. Les implémentations réelles sont dans
// restart_{windows,linux,darwin}.go.
func restartService() error {
	logf("restartService : no-op (OS non supporté)")
	return nil
}
