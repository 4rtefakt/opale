//go:build !windows

package main

// Stub : pas de signaux santé hors Windows pour le moment.
func collectHealth() *HealthSignals { return nil }
