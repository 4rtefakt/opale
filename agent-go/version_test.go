package main

import "testing"

// Le serveur ne propose l'auto-update que si la version servie est
// strictement supérieure à celle remontée par le poste : la flotte en
// 2.14.0 doit recevoir cette version (correctifs de sécurité).
func TestAgentVersionAboveDeployedFleet(t *testing.T) {
	if !semverGT(AgentVersion, "2.14.0") {
		t.Fatalf("AgentVersion %q doit être > 2.14.0 pour être proposée à la flotte", AgentVersion)
	}
}
