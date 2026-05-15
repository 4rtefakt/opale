//go:build !windows && !linux && !darwin

package main

// Stub pour OS non supportés (BSD, Solaris…). Les implémentations réelles
// sont dans health_{windows,linux,darwin}.go.
func collectHealth() *HealthSignals { return nil }
