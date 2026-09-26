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

// Un binaire 2.15.0 construit depuis main avant les correctifs de livraison
// (résultats acquittés, réponses des re-checkins traitées) a pu être
// installé (poste pilote) : cette version doit lui être proposée, et le
// serveur ne doit pas le prendre pour un agent qui traite toute réponse
// (AGENT_PROCESSES_EVERY_RESPONSE côté API).
func TestAgentVersionAboveUnfixed2150(t *testing.T) {
	if !semverGT(AgentVersion, "2.15.0") {
		t.Fatalf("AgentVersion %q doit être > 2.15.0 (build 2.15.0 sans les correctifs de livraison)", AgentVersion)
	}
}
