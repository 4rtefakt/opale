// Rapports d'application d'un agent Linux (docs/linux-fleet-design.md §2 et
// §4) : ligne append-only par exécution, état `last_*` du poste, transitions
// auditées, puis alertes (push, proposition de ticket, événement système)
// derrière `linux.alerts_enabled`. Reçoit `db` : testable sur schéma réel.

import { stripNul, clipStr, truncateMiddle } from '../../inventory/lib/checkin-validation.js'
import { logAudit } from '../../core/lib/audit.js'
import { sendPushToAll } from '../../core/routes/push.js'
import { createLinuxApplyProposal } from '../../monitoring/lib/linux-apply-proposal.js'
import { attachSystemEventToOpenTicketsOfDevice } from '../../tickets/lib/ticket-events.js'
import { modulesConfig } from '../../../modules.config.js'

export const ERROR_SUMMARY_MAX  = 1024
export const LOG_TAIL_MAX_BYTES = 8192
const AGENT_VERSION_MAX = 40
const PUSH_SUMMARY_MAX  = 200

const FAILING = new Set(['failed', 'partial'])

// Transition d'état (design §4) : seuls les passages entre « en échec »
// (failed, partial) et « sain » (success, skipped, ou jamais rapporté) comptent ;
// rester en échec ou rester sain n'est pas une transition.
export function applyTransition(previous, status) {
  const wasFailing = FAILING.has(previous)
  const failing = FAILING.has(status)
  if (failing && !wasFailing) return 'failed'
  if (!failing && wasFailing) return 'recovered'
  return null
}

// Colonnes de linux_apply_reports à partir d'un ReportRequest validé : NUL
// retirés (Postgres les refuse), résumé borné, journal tronqué tête + queue
// et conservé seulement pour un échec (rien à lire sur success / skipped).
export function sanitizeReport(body) {
  const keepLog = FAILING.has(body.status) && body.log_tail != null
  return {
    revision:      body.revision ?? null,
    status:        body.status,
    started_at:    body.started_at,
    finished_at:   body.finished_at,
    error_summary: clipStr(stripNul(body.error_summary), ERROR_SUMMARY_MAX),
    log_tail:      keepLog ? truncateMiddle(stripNul(body.log_tail), LOG_TAIL_MAX_BYTES) : null,
    agent_version: clipStr(stripNul(body.agent_version), AGENT_VERSION_MAX),
  }
}

const AUDIT = {
  failed:    { action: 'linux_apply_failed',    level: 'error' },
  recovered: { action: 'linux_apply_recovered', level: 'info'  },
}

// Une transaction par rapport : l'état précédent est lu sous verrou pour que
// deux rapports simultanés du même poste ne produisent pas deux transitions.
// `last_successful_revision` n'avance que sur success (skipped garde la précédente).
export async function recordReport(db, log, { deviceId, fingerprint, body }) {
  const report = sanitizeReport(body)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [device] } = await client.query(
      "SELECT hostname, last_apply_status FROM devices WHERE id = $1 AND managed_by = 'pull' FOR UPDATE", [deviceId],
    )
    if (!device) throw new Error(`Rapport d’une clé sans poste pull : ${deviceId}`)
    const transition = applyTransition(device.last_apply_status, report.status)
    const { rows: [row] } = await client.query(`
      INSERT INTO linux_apply_reports (device_id, revision, status, started_at, finished_at, error_summary, log_tail, agent_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, received_at
    `, [deviceId, report.revision, report.status, report.started_at, report.finished_at, report.error_summary, report.log_tail, report.agent_version])
    await client.query(`
      UPDATE devices SET last_revision_applied = $2, last_apply_status = $3, last_apply_at = $4,
        last_successful_revision = CASE WHEN $3 = 'success' THEN $2 ELSE last_successful_revision END
      WHERE id = $1
    `, [deviceId, report.revision, report.status, report.finished_at])
    if (transition) {
      const { action, level } = AUDIT[transition]
      await logAudit(client, log, {
        action, byUser: 'device:' + fingerprint.slice(0, 12), target: deviceId,
        details: { level, revision: report.revision, hostname: device.hostname, ...(transition === 'failed' && { error_summary: report.error_summary }) },
      })
    }
    await client.query('COMMIT')
    return { id: row.id, received_at: row.received_at, transition, deviceId, hostname: device.hostname, revision: report.revision, error_summary: report.error_summary }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Historique d'un poste (lignes ApplyReport), même ordre que `last_report`
// du détail. null quand le poste n'est pas géré par état désiré.
export async function listReports(db, deviceId, { status, limit = 50, offset = 0 } = {}) {
  const { rowCount } = await db.query("SELECT 1 FROM devices WHERE id = $1 AND managed_by = 'pull'", [deviceId])
  if (!rowCount) return null
  const params = [deviceId, limit, offset]
  if (status !== undefined) params.push(status)
  const { rows } = await db.query(`
    SELECT id, revision, status, started_at, finished_at, error_summary, log_tail, agent_version, received_at, count(*) OVER() AS total_count
    FROM linux_apply_reports
    WHERE device_id = $1 ${status !== undefined ? 'AND status = $4' : ''}
    ORDER BY started_at DESC NULLS LAST, received_at DESC
    LIMIT $2 OFFSET $3
  `, params)
  return { rows: rows.map(({ total_count, ...row }) => row), total: Number(rows[0]?.total_count ?? 0) }
}

// Alertes d'un passage en échec (design §4), derrière `linux.alerts_enabled` :
// push aux admins (même forme que les alertes de conformité), proposition de
// ticket idempotente et événement système sur les tickets ouverts du poste.
// Best-effort de bout en bout : un échec est journalisé, jamais remonté.
export async function alertApplyFailure(fastify, { id, deviceId, hostname, revision, error_summary: errorSummary }) {
  const { db, log } = fastify
  try {
    const { rows: [setting] } = await db.query("SELECT value FROM settings WHERE key = 'linux.alerts_enabled'")
    if (setting?.value !== 'true') return
    const short = revision ? revision.slice(0, 7) : 'révision inconnue'
    const detail = summary => (summary ? ` : ${summary}` : '')
    const tasks = [
      sendPushToAll(fastify, {
        title: `⚠ Linux — ${hostname}`,
        body:  `Application de la configuration en échec (${short})${detail(clipStr(errorSummary, PUSH_SUMMARY_MAX))}`,
        deviceId,
        url:   `/mobile.html#/poste/${deviceId}`,
      }),
    ]
    // Propositions et fils de tickets appartiennent au module tickets (optionnel).
    if (modulesConfig.tickets) {
      tasks.push(
        createLinuxApplyProposal(db, { deviceId, hostname, revision, errorSummary, reportId: id }),
        attachSystemEventToOpenTicketsOfDevice(db, deviceId, 'Système', `Application Linux en échec (${short})${detail(errorSummary)}`),
      )
    }
    for (const result of await Promise.allSettled(tasks)) {
      if (result.status === 'rejected') log.warn({ err: result.reason.message, device_id: deviceId }, 'linux reports: alerte non envoyée')
    }
  } catch (err) {
    log.warn({ err: err.message, device_id: deviceId }, 'linux reports: alertes ignorées')
  }
}
