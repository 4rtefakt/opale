//go:build !windows

package main

// Hors Windows, pas de compte local géré : MaybeRotateAdminPassword ne fait
// rien (et surtout n'escrowe rien) même si laps_enabled est positionné.
func platformLAPSAccounts() lapsAccountStore { return nil }
