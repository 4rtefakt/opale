package main

import (
	"context"
	"time"
)

// CheckinInterval — fréquence du checkin. 15 min comme inventory.ps1.
const CheckinInterval = 15 * time.Minute

// runCheckin — un cycle de checkin complet avec gestion d'erreur, rollback,
// update et exécution des commandes/déploiements/détections demandés par le
// serveur. Portable, partagé entre le service Windows et le mode --debug.
func runCheckin(ctx context.Context, cfg *Config, st *State) {
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	resp, err := DoCheckin(c, cfg, st)
	CheckRollback(st, err)
	if err != nil {
		logError("checkin-fail", err, nil)
		return
	}
	logInfo("checkin-ok", "", LogFields{
		"device_id": resp.DeviceID,
		"is_new":    resp.New,
	})
	// DoCheckin draine PendingDeployments/Detections en mémoire — on
	// persiste ici pour que le state.json reflète ce qui a été remonté.
	st.Save()
	// Rafraîchissement du cache runtime-config si TTL expiré (no-op
	// sinon). Garantit que les changements UI Paramètres sont vus au
	// cycle suivant sans attendre une rotation LAPS (30j).
	GetRuntimeConfig(httpClient, cfg.URL, cfg.Token)
	// Rotation token éventuelle (toutes les 30j). Non bloquante.
	MaybeRotateToken(ctx, cfg, st)
	// Rotation mdp admin local (LAPS-like, opt-in via cfg.LAPSEnabled).
	MaybeRotateAdminPassword(ctx, cfg, st)

	// Fenêtre de maintenance : si déclarée et qu'on est en dehors, on
	// défère les actions perturbantes (auto-update + deployments).
	// Les commandes admin et la détection passent toujours.
	inWindow := resp.MaintenanceWindow.IsActive(time.Now())

	// L'auto-update est traité avant les commandes : si on est sur le
	// point de redémarrer pour passer à une nouvelle version, on évite
	// d'exécuter des scripts qui pourraient être interrompus à mi-course.
	if resp.AgentUpdate != nil {
		if !inWindow {
			logInfo("update-deferred", "hors fenêtre de maintenance", LogFields{
				"target_version": resp.AgentUpdate.LatestVersion,
			})
		} else {
			if err := HandleAgentUpdate(c, cfg, st, resp.AgentUpdate); err != nil {
				logError("update-fail", err, LogFields{"target_version": resp.AgentUpdate.LatestVersion})
			}
			// Si l'update a abouti, le service va redémarrer ; on évite de
			// déclencher des déploiements potentiellement longs.
			return
		}
	}

	// Commandes — chaque résultat est POST individuellement. Pas filtrées
	// par la maintenance window : ce sont des actions admin-initiated qui
	// nécessitent souvent une réponse rapide (debug, fix).
	if len(resp.Commands) > 0 {
		processCommands(ctx, cfg, resp.Commands)
	}

	// Déploiements + détections post-install — résultats stash en state.
	var depResults []DeploymentResult
	var detResults []DetectionResult
	if len(resp.Deployments) > 0 {
		if !inWindow {
			logInfo("deployments-deferred", "hors fenêtre de maintenance", LogFields{
				"deferred": len(resp.Deployments),
			})
			// On ne pull PAS les rows de la table deployments (elles restent
			// 'running' côté DB sans timeout). À améliorer : remettre à 'pending'.
			// Pour le moment l'API les passe à 'running' à chaque checkin ; donc
			// on défère côté agent uniquement (pas d'effet de bord côté DB).
		} else {
			depResults, detResults = processDeployments(ctx, resp.Deployments)
		}
	}
	if len(resp.Detect) > 0 {
		detResults = append(detResults, processDetect(ctx, resp.Detect)...)
	}

	if len(depResults) == 0 && len(detResults) == 0 {
		return
	}

	// Persister avant le re-checkin : si la machine reboot ou perd réseau,
	// les résultats ne sont pas perdus.
	st.PendingDeployments = append(st.PendingDeployments, depResults...)
	st.PendingDetections  = append(st.PendingDetections, detResults...)
	st.Save()

	// Re-checkin immédiat pour remonter les résultats sans attendre 15min.
	// DoCheckin draine PendingDeployments/Detections de l'état.
	if len(depResults) > 0 {
		logInfo("recheckin-post-deploy", "", LogFields{"results": len(depResults)})
		c2, cancel2 := context.WithTimeout(ctx, 60*time.Second)
		defer cancel2()
		if _, err := DoCheckin(c2, cfg, st); err != nil {
			logError("recheckin-fail", err, LogFields{"deferred_results": len(depResults)})
		} else {
			st.Save() // état nettoyé par DoCheckin → drainXxx
		}
	}
}

// runDebugLoop — mode interactif (non-service). Utilisé via --debug.
func runDebugLoop(ctx context.Context, cfg *Config, st *State) error {
	logf("mode --debug : checkin immédiat puis interval %s", CheckinInterval)
	// WS persistant en parallèle du polling. Indépendant : si le tube WS
	// tombe, le polling continue ; si le polling échoue, le WS continue.
	go RunWSClient(ctx, cfg)
	runCheckin(ctx, cfg, st)
	tick := time.NewTicker(CheckinInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
			runCheckin(ctx, cfg, st)
		}
	}
}
