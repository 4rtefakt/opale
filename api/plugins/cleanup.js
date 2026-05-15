import fp from 'fastify-plugin'

// Durées de conservation RGPD (docs/rgpd.md)
//
// Note remote_session_logs (30j) plus court que remote_sessions (183j) :
// les frames raw contiennent le contenu intégral du terminal (mots de
// passe affichés, données users) — sensibilité bien plus haute que les
// métadonnées de session. La FK ON DELETE CASCADE garantit en plus que
// le log suit si la session parente est purgée.
const RULES = [
  { table: 'bandwidth_stats',      col: 'sampled_at', days: 30  },
  { table: 'ping_stats',           col: 'sampled_at', days: 30  },
  { table: 'remote_session_logs',  col: 'created_at', days: 30  },
  { table: 'remote_sessions',      col: 'started_at', days: 183 },
  { table: 'audit_logs',           col: 'created_at', days: 365 },
  { table: 'script_executions',    col: 'started_at', days: 90  },
]

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

async function runCleanup(fastify) {
  for (const { table, col, days } of RULES) {
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

  // Timeout deployments stuck running : toutes les 15 min (granularité
  // alignée avec l'intervalle de checkin agent).
  fastify.addHook('onReady', () => timeoutStuckDeployments(fastify))
  const timeoutInterval = setInterval(() => timeoutStuckDeployments(fastify), 15 * 60 * 1000)
  fastify.addHook('onClose', () => clearInterval(timeoutInterval))
}

export default fp(cleanupPlugin)
