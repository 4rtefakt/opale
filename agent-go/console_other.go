//go:build !windows

package main

import "errors"

// Stubs pour les builds non-Windows (tests sur Mac/Linux). L'agent en prod
// tourne en Windows Service ; les autres OS ne servent qu'à compiler et
// tester la couche WS / cross-platform.

func spawnConsole(shell string, cols, rows uint16) (consolePTY, error) {
	return nil, errors.New("console non supportée sur cet OS (agent prod = Windows uniquement)")
}

// La capability "console" n'est PAS annoncée hors Windows, donc le serveur
// ne tentera jamais d'envoyer console.open ; la défense en profondeur dans
// spawnConsole reste là pour garantir qu'un dispatch malicieux ne crash pas.
func wsCapabilitiesPlatform() []string {
	return []string{}
}

func notifyConsoleOpened(sessionID string) {
	// no-op
}
