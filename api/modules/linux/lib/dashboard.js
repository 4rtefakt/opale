// KPIs du parc Linux (schéma LinuxDashboard, docs/linux-fleet-design.md §5).
// Retard et escrow manquant sont comptés par la vue des postes : une seule
// définition (device-view.js), la même que la liste des postes et /rings.
// `offline` reprend le seuil `agent_offline_days` du dashboard général.

import { listLinuxDevices } from './device-view.js'

export async function linuxDashboard(db, ctx, mirrorState) {
  const { rows: [setting] } = await db.query("SELECT value FROM settings WHERE key = 'agent_offline_days'")
  const days = parseInt(setting?.value ?? '7', 10)
  const count = filters => listLinuxDevices(db, { ...filters, limit: 1 }, ctx).then(page => page.total)
  const [{ rows: [totals] }, { rows: byRevision }, { rows: [keys] }, lagging, notEscrowed] = await Promise.all([
    db.query(`
      SELECT count(*)::int AS devices_total,
             count(*) FILTER (WHERE last_apply_status IN ('failed', 'partial'))::int AS failed_applies,
             count(*) FILTER (WHERE last_seen IS NULL OR last_seen < now() - make_interval(days => $1))::int AS offline
      FROM devices WHERE managed_by = 'pull'
    `, [days]),
    // Une entrée par (révision, ring), révision NULL comprise (jamais appliqué avec succès).
    db.query(`
      SELECT last_successful_revision AS revision, ring, count(*)::int AS count
      FROM devices WHERE managed_by = 'pull'
      GROUP BY last_successful_revision, ring
      ORDER BY count DESC, ring, revision
    `),
    db.query("SELECT count(*)::int AS pending FROM linux_device_keys WHERE status = 'pending'"),
    count({ lagging: true }),
    count({ escrow: 'missing' }),
  ])
  return {
    devices_total:     totals.devices_total,
    by_revision:       byRevision,
    lagging,
    offline:           { days, count: totals.offline },
    failed_applies:    totals.failed_applies,
    pending_approvals: keys.pending,
    not_escrowed:      notEscrowed,
    mirror_state:      mirrorState,
  }
}
