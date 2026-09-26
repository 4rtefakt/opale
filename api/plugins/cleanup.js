import fp from 'fastify-plugin'

// Durées de conservation RGPD : définies dans lib/retention.js (seule
// source, partagée avec le nettoyage du checkin agent).
import { RETENTION_RULES } from '../lib/retention.js'

// Timeout pour les déploiements bloqués en 'running' : si l'agent prend
// un déploiement en charge puis crash (install qui kill le réseau / le
// process, ex: Netbird coupe le VPN au milieu) et ne POST jamais son
// résultat, le row reste en 'running' à vie. Au bout d'1h on le passe
// en 'failed' avec un message explicite, ce qui permet à l'admin de
// retry via le bouton "Rejouer" sur la fiche package.
const DEPLOYMENT_RUNNING_TIMEOUT_MIN = 60

async function timeoutStuckDeployments(fastify) {
  try {
    const res = await fastify.db.query(`
      UPDATE deployments
      SET status       = 'failed',
          completed_at = now(),
          output       = COALESCE(output, '') || E'\n[serveur] Timeout : aucun résultat reçu de l''agent après ${DEPLOYMENT_RUNNING_TIMEOUT_MIN} min. Cliquer Rejouer pour réessayer.'
      WHERE status = 'running'
        AND started_at < now() - INTERVAL '${DEPLOYMENT_RUNNING_TIMEOUT_MIN} minutes'
    `)
    if (res.rowCount > 0) {
      fastify.log.info({ count: res.rowCount }, 'cleanup: deployments stuck running → failed')
    }
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'cleanup: timeout deployments échoué (non-bloquant)')
  }
}

// Même garde-fou pour les scripts lancés via l'agent (mode 'agent') :
// réservés ('running') au checkin, ils attendent le POST /api/agent/result.
// Si la réponse du checkin se perd (client déconnecté après la
// réservation), si l'agent crashe ou si le poste s'éteint pendant
// l'exécution, le résultat n'arrive jamais et la ligne restait 'running'
// à vie. L'agent coupe chaque script à 5 min et en reçoit au plus 5 par
// checkin : 60 min laissent une large marge. Statut 'error' (celui d'un
// échec renvoyé par l'agent) avec un message explicite ; un résultat qui
// arriverait plus tard écrase toujours la ligne. Les exécutions SSH
// (mode 'ssh', pilotées par l'API elle-même) ne sont pas concernées.
const SCRIPT_RUNNING_TIMEOUT_MIN = 60

async function timeoutStuckScripts(fastify) {
  try {
    const res = await fastify.db.query(`
      UPDATE script_executions
      SET status       = 'error',
          completed_at = now(),
          -- output est VARCHAR(10000) : on garde la place du message (sinon
          -- 22001 sur une ligne ferait échouer tout l'UPDATE, à chaque passage).
          output       = left(COALESCE(output, ''), 9800) || E'\n[serveur] Timeout : aucun résultat reçu de l''agent après ${SCRIPT_RUNNING_TIMEOUT_MIN} min. Relancer le script si besoin.'
      WHERE mode = 'agent'
        AND status = 'running'
        AND started_at < now() - INTERVAL '${SCRIPT_RUNNING_TIMEOUT_MIN} minutes'
    `)
    if (res.rowCount > 0) {
      fastify.log.info({ count: res.rowCount }, 'cleanup: scripts agent stuck running → error')
    }
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'cleanup: timeout scripts échoué (non-bloquant)')
  }
}

async function timeoutStuck(fastify) {
  await timeoutStuckDeployments(fastify)
  await timeoutStuckScripts(fastify)
}

// Exportée pour les tests.
export async function runCleanup(fastify) {
  for (const { table, col, days } of RETENTION_RULES) {
    try {
      const res = await fastify.db.query(
        `DELETE FROM ${table} WHERE ${col} < now() - interval '${days} days'`
      )
      if (res.rowCount > 0) {
        fastify.log.info({ table, deleted: res.rowCount }, 'cleanup: purge effectuée')
      }
    } catch (err) {
      fastify.log.warn({ err: err.message, table }, 'cleanup: échec purge (non-bloquant)')
    }
  }
}

async function cleanupPlugin(fastify) {
  // Purge RGPD : tous les jours
  fastify.addHook('onReady', () => runCleanup(fastify))
  const purgeInterval = setInterval(() => runCleanup(fastify), 24 * 60 * 60 * 1000)
  fastify.addHook('onClose', () => clearInterval(purgeInterval))

  // Timeout deployments / scripts agent stuck running : toutes les 15 min
  // (granularité alignée avec l'intervalle de checkin agent).
  fastify.addHook('onReady', () => timeoutStuck(fastify))
  const timeoutInterval = setInterval(() => timeoutStuck(fastify), 15 * 60 * 1000)
  fastify.addHook('onClose', () => clearInterval(timeoutInterval))
}

export default fp(cleanupPlugin)
