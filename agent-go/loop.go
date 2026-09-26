package main

import (
	"context"
	"time"
)

// CheckinInterval — fréquence du checkin. 15 min comme inventory.ps1.
const CheckinInterval = 15 * time.Minute

// maxFollowUpCheckins — re-checkins post-déploiement enchaînés au plus dans
// un cycle (le serveur distribue les déploiements par lots de 10). Au-delà,
// plus de re-checkin, donc plus de réservation : les derniers résultats et
// les déploiements encore en attente partent au cycle suivant.
const maxFollowUpCheckins = 10

// Indirections pour les tests (exécution réelle : PowerShell / winget sous
// Windows ; mise à jour : téléchargement et permutation du binaire).
var (
	processCommandsFn    = processCommands
	processDeploymentsFn = processDeployments
	processDetectFn      = processDetect
	handleAgentUpdateFn  = HandleAgentUpdate
)

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
	// DoCheckin a retiré de PendingDeployments/Detections les résultats
	// acceptés par le serveur — on persiste pour que le state.json le reflète.
	st.Save()
	// Rafraîchissement du cache runtime-config si TTL expiré (no-op
	// sinon). Garantit que les changements UI Paramètres sont vus au
	// cycle suivant sans attendre une rotation LAPS (30j).
	GetRuntimeConfig(httpClient, cfg.URL, cfg.token())
	// Rotation token éventuelle (toutes les 30j). Non bloquante.
	MaybeRotateToken(ctx, cfg, st)
	// Rotation mdp admin local (LAPS-like, opt-in via cfg.LAPSEnabled).
	MaybeRotateAdminPassword(ctx, cfg, st)

	// Toute réponse est traitée en entier, celles des re-checkins comprises :
	// le serveur y a déjà passé en 'running' les scripts et déploiements
	// qu'elle porte. Ignorés, ils restaient 'running' jusqu'au timeout sans
	// avoir tourné.
	for followUps := 0; ; followUps++ {
		deployed := processCheckinJobs(ctx, cfg, st, resp)
		// Arrêt de l'agent (Stop) : pas de re-checkin, donc rien de plus
		// réservé ; les résultats en file partiront au prochain démarrage.
		if deployed == 0 || followUps >= maxFollowUpCheckins || ctx.Err() != nil {
			break
		}
		// Re-checkin immédiat pour remonter les résultats sans attendre
		// 15 min ; sa réponse peut porter de nouveaux travaux (lot suivant).
		logInfo("recheckin-post-deploy", "", LogFields{"results": deployed})
		next, err := recheckin(ctx, cfg, st)
		if err != nil {
			logError("recheckin-fail", err, LogFields{"deferred_results": len(st.PendingDeployments)})
			break
		}
		if ctx.Err() != nil {
			// Arrêt pendant le re-checkin : ses travaux ne sont pas lancés
			// (contexte annulé, ils seraient remontés en échec sans avoir
			// tourné) ; réservés côté serveur, ils relèvent du timeout.
			logWarn("recheckin-jobs-skipped", "arrêt de l'agent", LogFields{
				"commands": len(next.Commands), "deployments": len(next.Deployments),
			})
			return
		}
		resp = next
	}
	if ctx.Err() != nil {
		return
	}

	// L'auto-update passe après les travaux (déjà réservés côté serveur) :
	// un binaire permuté redémarre le service, ce qui interromprait un
	// script en cours ou abandonnerait les travaux restants. Dernière
	// réponse reçue = dernier état du serveur. Fenêtre revérifiée ici (les
	// travaux ont pu durer au-delà) : sans perte, la mise à jour est
	// reproposée au checkin suivant.
	if resp.AgentUpdate != nil {
		if !resp.MaintenanceWindow.IsActive(time.Now()) {
			logInfo("update-deferred", "hors fenêtre de maintenance", LogFields{
				"target_version": resp.AgentUpdate.LatestVersion,
			})
		} else {
			cu, cancelU := context.WithTimeout(ctx, 60*time.Second)
			defer cancelU()
			if err := handleAgentUpdateFn(cu, cfg, st, resp.AgentUpdate); err != nil {
				logError("update-fail", err, LogFields{"target_version": resp.AgentUpdate.LatestVersion})
			}
		}
	}
}

// recheckin — checkin de remontée des résultats, avec son propre délai.
// DoCheckin ne retire les résultats de l'état qu'une fois acceptés.
func recheckin(ctx context.Context, cfg *Config, st *State) (*CheckinResponse, error) {
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	resp, err := DoCheckin(c, cfg, st)
	if err == nil {
		st.Save() // résultats acquittés retirés par DoCheckin
	}
	return resp, err
}

// processCheckinJobs exécute les commandes, déploiements et détections
// d'une réponse de checkin et met leurs résultats en file (state persisté).
// Retourne le nombre de résultats de déploiement produits.
func processCheckinJobs(ctx context.Context, cfg *Config, st *State, resp *CheckinResponse) int {
	// Commandes — chaque résultat est POST individuellement. Pas filtrées
	// par la maintenance window : ce sont des actions admin-initiated qui
	// nécessitent souvent une réponse rapide (debug, fix).
	if len(resp.Commands) > 0 {
		processCommandsFn(ctx, cfg, resp.Commands)
	}

	// Déploiements + détections post-install — résultats mis en file et
	// persistés un par un, dès qu'ils sont connus (cf. resultSink) : un
	// reboot, une coupure ou un installeur qui tue l'agent en cours de lot
	// ne perd pas ceux déjà obtenus.
	// Fenêtre de maintenance appliquée par le serveur, qui ne réserve les
	// déploiements qu'en fenêtre : l'agent exécute ce qu'il a reçu. Les
	// déférer ici (avis divergent : fuseau, format, horloge) les laissait
	// 'running' sans exécution jusqu'au timeout (1 h), puis en échec.
	deployed := 0
	if len(resp.Deployments) > 0 {
		processDeploymentsFn(ctx, resp.Deployments, resultSink{
			deployment: func(r DeploymentResult) {
				st.PendingDeployments = append(st.PendingDeployments, r)
				st.Save()
				deployed++
			},
			detection: func(r DetectionResult) {
				st.PendingDetections = append(st.PendingDetections, r)
				st.Save()
			},
		})
	}
	if len(resp.Detect) > 0 {
		if dets := processDetectFn(ctx, resp.Detect); len(dets) > 0 {
			st.PendingDetections = append(st.PendingDetections, dets...)
			st.Save()
		}
	}
	return deployed
}

// runDebugLoop — mode interactif (non-service). Utilisé via --debug.
// WS persistant en parallèle du polling (cf. runAgent). Si un
// redémarrage est demandé (binaire permuté par l'auto-update sous
// Windows), la boucle s'arrête : l'opérateur relance l'agent.
func runDebugLoop(ctx context.Context, cfg *Config, st *State) error {
	logf("mode --debug : checkin immédiat puis interval %s", CheckinInterval)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-restartRequests:
			logf("redémarrage demandé (nouveau binaire) : arrêt du mode --debug, relancer l'agent")
			cancel()
		case <-ctx.Done():
		}
	}()
	runAgent(ctx, CheckinInterval,
		func(ctx context.Context) { runCheckin(ctx, cfg, st) },
		func(ctx context.Context) { RunWSClient(ctx, cfg) })
	return nil
}
