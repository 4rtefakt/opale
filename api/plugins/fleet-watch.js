import fp from 'fastify-plugin'
import { sendPushToAll } from '../modules/core/routes/push.js'

// Détecteur "parc muet" — filet de sécurité né de l'incident 07/2026 où
// TOUT le parc a cessé de checkin pendant ~2 jours (bug agent : gel total)
// sans qu'aucune alarme ne se déclenche. On surveille ici une chute nette
// et globale des checkins.
//
// Signal retenu : détection de FALAISE, pas de simple silence. On alerte si
//   - aucun agent n'a checkin dans les RECENT_MIN dernières minutes, ALORS
//   - qu'au moins MIN_PRIOR agents avaient checkin dans la fenêtre juste
//     avant (PRIOR).
// Ce couplage évite les faux positifs nuit/week-end (si les postes étaient
// déjà éteints, la fenêtre PRIOR est vide aussi → pas d'alerte) tout en
// captant l'incident réel (passage brutal de ~tout-le-parc à zéro).
//
// Ne compte que les postes AGENT (agent_version non nul) : les devices
// Intune-only qui ne font jamais de checkin ne doivent pas peser.

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // fréquence d'évaluation
const RECENT_MIN        = 45            // fenêtre "récente" (≈ 3 cycles de 15 min)
const PRIOR_HOURS       = 3             // borne haute de la fenêtre "avant"
const MIN_PRIOR         = 3             // nb mini d'agents actifs "avant" pour armer

const ALERT_TYPE = 'fleet_silent'

async function evaluateFleetSilence(fastify) {
  try {
    const recentInterval = `${RECENT_MIN} minutes`
    const priorInterval  = `${PRIOR_HOURS} hours`
    const { rows } = await fastify.db.query(`
      SELECT
        count(*) FILTER (
          WHERE last_seen > now() - $1::interval
        ) AS recent,
        count(*) FILTER (
          WHERE last_seen BETWEEN now() - $2::interval
                              AND now() - $1::interval
        ) AS prior
      FROM devices
      WHERE agent_version IS NOT NULL
    `, [recentInterval, priorInterval])

    const recent = Number(rows[0]?.recent ?? 0)
    const prior  = Number(rows[0]?.prior ?? 0)

    const { rows: openRows } = await fastify.db.query(
      `SELECT id FROM alerts WHERE type = $1 AND resolved_at IS NULL LIMIT 1`,
      [ALERT_TYPE]
    )
    const openAlert = openRows[0]

    // Reprise : des checkins arrivent à nouveau → on résout l'alerte.
    if (recent > 0) {
      if (openAlert) {
        await fastify.db.query(
          `UPDATE alerts SET resolved_at = now() WHERE id = $1`,
          [openAlert.id]
        )
        fastify.log.info({ alertId: openAlert.id }, 'fleet-watch: checkins repris → alerte résolue')
        sendPushToAll(fastify, {
          title: '✓ Parc RMM',
          body:  'Les agents recommencent à checkin.',
          url:   '/',
        }).catch(err => fastify.log.warn({ err: err.message }, 'push failed (non-bloquant)'))
      }
      return
    }

    // Falaise : silence récent total + activité juste avant → alerte (une seule).
    if (recent === 0 && prior >= MIN_PRIOR) {
      if (openAlert) return // déjà signalé, pas de doublon
      const message = `Aucun checkin d'agent depuis ${RECENT_MIN} min alors que ${prior} postes étaient actifs juste avant. Le parc est peut-être muet (panne serveur ou agents gelés).`
      const { rows: ins } = await fastify.db.query(
        `INSERT INTO alerts (type, device_id, message, threshold, value)
         VALUES ($1, NULL, $2, $3, 0) RETURNING id`,
        [ALERT_TYPE, message, MIN_PRIOR]
      )
      fastify.log.warn({ alertId: ins[0]?.id, prior }, 'fleet-watch: PARC MUET détecté')
      sendPushToAll(fastify, {
        title: '⚠ Parc RMM muet',
        body:  `Aucun checkin depuis ${RECENT_MIN} min (${prior} postes actifs juste avant).`,
        url:   '/',
      }).catch(err => fastify.log.warn({ err: err.message }, 'push failed (non-bloquant)'))
    }
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'fleet-watch: évaluation échouée (non-bloquant)')
  }
}

async function fleetWatchPlugin(fastify) {
  const timer = setInterval(() => evaluateFleetSilence(fastify), CHECK_INTERVAL_MS)
  fastify.addHook('onClose', () => clearInterval(timer))
  // Pas d'évaluation onReady : au boot, la fenêtre PRIOR peut être trompeuse
  // (l'API vient de redémarrer). On laisse passer un premier intervalle.
}

export default fp(fleetWatchPlugin)
