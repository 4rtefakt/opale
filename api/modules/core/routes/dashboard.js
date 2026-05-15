// Endpoint dashboard — payload optimisé pour la vue dashboard actuelle.

import fs from 'fs'
import path from 'path'
import { RULES } from '../../monitoring/lib/compliance.js'

const AGENT_GO_DIR   = process.env.AGENT_GO_DIR || 'agent-go'
const AGENT_VER_PATH = process.env.AGENT_GO_VERSION_FILE || path.join(AGENT_GO_DIR, 'dist', 'agent-version.txt')

function readLatestAgentVersion() {
  try {
    const content = fs.readFileSync(AGENT_VER_PATH, 'utf8').trim()
    const m = content.match(/AgentVersion\s*=\s*"([^"]+)"/)
    return m ? m[1] : (content || null)
  } catch { return null }
}

// Actions audit_logs masquées sur le dashboard. Mêmes que la catégorie
// "default" du journal d'audit (cf. front/views/audit.js).
const AUDIT_NOISY = ['agent_ws_connect', 'agent_ws_disconnect', 'agent_checkin', 'setup_script']

function severityRank(sev) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[sev] || 0
}

export default async function dashboardRoute(fastify) {
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    // Seuils paramétrables (settings). Mêmes defaults qu'ailleurs.
    const settingsRes = await fastify.db.query(
      `SELECT key, value FROM settings WHERE key IN ('disk_warn_pct','disk_critical_pct','agent_offline_days')`
    )
    const s = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]))
    const diskWarn    = parseInt(s.disk_warn_pct      ?? '80', 10)
    const diskCrit    = parseInt(s.disk_critical_pct  ?? '90', 10)
    const offlineDays = parseInt(s.agent_offline_days ?? '7',  10)

    const [
      statsRes,
      alertsCountRes,
      ticketsCountRes,
      ticketsListRes,
      stockRes,
      proposalsRes,
      deploysRes,
      complianceAggRes,
      failingDevicesRes,
      unhealthyRes,
      activityRes,
      versionsRes,
    ] = await Promise.all([
      fastify.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE last_seen > now() - interval '1 hour')                      AS online,
          COUNT(*) FILTER (WHERE last_seen IS NULL OR last_seen < now() - interval '1 hour') AS offline,
          COUNT(*) FILTER (WHERE disk_used_pct >= $1)                                        AS disk_critical,
          COUNT(*)                                                                            AS total
        FROM devices
      `, [diskCrit]),
      // KPI alertes : compte réel (pas LIMIT 5 comme avant).
      fastify.db.query(`SELECT COUNT(*)::int AS n FROM alerts WHERE resolved_at IS NULL`),
      fastify.db.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE status NOT IN ('resolved','closed')`),
      fastify.db.query(`
        SELECT t.id, t.title, t.status, t.is_auto, t.priority, t.created_at,
               t.user_id, u.display_name AS user_name, u.email AS user_email
        FROM tickets t
        LEFT JOIN users_cache u ON t.user_id = u.entra_id
        WHERE t.status NOT IN ('resolved','closed')
        ORDER BY t.created_at DESC LIMIT 5
      `),
      fastify.db.query(`SELECT COUNT(*)::int AS n FROM stock_items WHERE quantity <= alert_threshold`),
      fastify.db.query(`SELECT COUNT(*)::int AS n FROM ticket_proposals WHERE status = 'pending'`),
      fastify.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'running')::int AS running,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM deployments
      `),
      // Aggregate compliance par règle. agent_seen_recent exclu car son
      // verdict en DB est obsolète pour les devices offline (cf. doc en tête
      // de api/routes/compliance.js).
      fastify.db.query(`
        SELECT rule_id, status, COUNT(*)::int AS n
        FROM compliance_results
        WHERE rule_id <> 'agent_seen_recent'
        GROUP BY rule_id, status
      `),
      // Nb de devices avec >=1 fail persisté.
      fastify.db.query(`
        SELECT COUNT(DISTINCT device_id)::int AS n
        FROM compliance_results
        WHERE status = 'fail' AND rule_id <> 'agent_seen_recent'
      `),
      // Top 5 postes "à surveiller". Score déterministe :
      //   disque ≥ crit_pct        → +30   (disque ≥ warn_pct → +15)
      //   chaque fail 'critical'   → +20
      //   chaque fail 'high'       → +10
      //   offline > offlineDays    → +25   (last_seen NULL → +25 aussi)
      // Trié desc, filtre score > 0 pour ne pas remonter les postes nominaux.
      fastify.db.query(`
        WITH fails AS (
          SELECT device_id,
                 COUNT(*) FILTER (WHERE status='fail' AND severity='critical')::int AS crit_fails,
                 COUNT(*) FILTER (WHERE status='fail' AND severity='high')::int     AS high_fails,
                 COUNT(*) FILTER (WHERE status='fail')::int                          AS total_fails
          FROM compliance_results
          WHERE rule_id <> 'agent_seen_recent'
          GROUP BY device_id
        )
        SELECT
          d.id, d.hostname, d.model, d.disk_used_pct, d.last_seen, d.ip_netbird,
          u.entra_id AS user_entra_id, u.display_name AS user_name,
          COALESCE(f.crit_fails, 0)  AS crit_fails,
          COALESCE(f.high_fails, 0)  AS high_fails,
          COALESCE(f.total_fails, 0) AS total_fails,
          (
            CASE WHEN d.disk_used_pct >= $1 THEN 30
                 WHEN d.disk_used_pct >= $2 THEN 15
                 ELSE 0 END
            + COALESCE(f.crit_fails, 0) * 20
            + COALESCE(f.high_fails, 0) * 10
            + CASE WHEN d.last_seen IS NULL THEN 25
                   WHEN d.last_seen < now() - make_interval(days => $3) THEN 25
                   ELSE 0 END
          )::int AS unhealth_score
        FROM devices d
        LEFT JOIN fails f       ON f.device_id    = d.id
        LEFT JOIN users_cache u ON u.entra_id     = d.assigned_user_id
        WHERE (
          d.disk_used_pct >= $2
          OR EXISTS (SELECT 1 FROM fails f2 WHERE f2.device_id = d.id AND (f2.crit_fails > 0 OR f2.high_fails > 0))
          OR d.last_seen IS NULL
          OR d.last_seen < now() - make_interval(days => $3)
        )
        ORDER BY unhealth_score DESC, d.disk_used_pct DESC NULLS LAST, d.hostname
        LIMIT 5
      `, [diskCrit, diskWarn, offlineDays]),
      // Activité récente — mêmes exclusions que la catégorie 'default' du
      // journal d'audit. Limite à 6 lignes (panneau dashboard, pas la vue
      // complète /audit).
      fastify.db.query(`
        SELECT al.id, al.action, al.by_user, al.target, al.details, al.created_at,
               COALESCE(d_host.id, d_uuid.id)             AS device_id,
               COALESCE(d_host.hostname, d_uuid.hostname) AS device_hostname
        FROM audit_logs al
        LEFT JOIN devices d_host ON d_host.hostname = al.target
        LEFT JOIN devices d_uuid ON d_uuid.id::text   = al.target
        WHERE al.action <> ALL($1::text[])
        ORDER BY al.created_at DESC
        LIMIT 6
      `, [AUDIT_NOISY]),
      // Distribution des versions agent. Trié desc count puis version, le
      // front décide s'il affiche (>1 version distincte = signal stuck).
      fastify.db.query(`
        SELECT agent_version, COUNT(*)::int AS count
        FROM devices
        WHERE agent_version IS NOT NULL
        GROUP BY agent_version
        ORDER BY count DESC, agent_version DESC
      `),
    ])

    const stats = statsRes.rows[0]

    // Compliance — recompose top règles + score parc à partir de l'agg.
    const aggMap = new Map() // rule_id → { pass, fail, not_applicable }
    for (const r of complianceAggRes.rows) {
      if (!aggMap.has(r.rule_id)) aggMap.set(r.rule_id, { pass: 0, fail: 0, not_applicable: 0 })
      aggMap.get(r.rule_id)[r.status] = r.n
    }
    const topFailingRules = RULES
      .map(rule => {
        const a = aggMap.get(rule.id) || { pass: 0, fail: 0, not_applicable: 0 }
        return { id: rule.id, label: rule.label, severity: rule.severity, fail: a.fail }
      })
      .filter(r => r.fail > 0)
      .sort((a, b) => b.fail - a.fail || severityRank(b.severity) - severityRank(a.severity))
      .slice(0, 5)

    let scorePass = 0, scoreFail = 0
    for (const r of complianceAggRes.rows) {
      if (r.status === 'pass') scorePass += r.n
      if (r.status === 'fail') scoreFail += r.n
    }
    const scoreEval = scorePass + scoreFail
    const scorePct  = scoreEval ? Math.round(100 * scorePass / scoreEval) : null

    return {
      thresholds: {
        disk_warn_pct:     diskWarn,
        disk_critical_pct: diskCrit,
        agent_offline_days: offlineDays,
      },
      kpis: {
        devices_online:           parseInt(stats.online),
        devices_offline:          parseInt(stats.offline),
        devices_total:            parseInt(stats.total),
        disk_critical:            parseInt(stats.disk_critical),
        alerts_active:            alertsCountRes.rows[0].n,
        tickets_open:             ticketsCountRes.rows[0].n,
        stock_low:                stockRes.rows[0].n,
        proposals_pending:        proposalsRes.rows[0].n,
        deployments_running:      deploysRes.rows[0].running,
        deployments_pending:      deploysRes.rows[0].pending,
        compliance_score_pct:     scorePct,
        compliance_failing_devs:  failingDevicesRes.rows[0].n,
      },
      recent_tickets:    ticketsListRes.rows,
      top_failing_rules: topFailingRules,
      unhealthy_devices: unhealthyRes.rows,
      recent_activity:   activityRes.rows,
      agent_versions: {
        latest:       readLatestAgentVersion(),
        distribution: versionsRes.rows,
      },
    }
  })
}
