// Affectation profil / ring d'un poste géré par état désiré (design §5) :
// prise en compte au prochain check-in, audit `linux_assignment_changed`
// avec avant/après. L'utilisateur passe par le helper inventaire partagé
// (setAssignedUser, audit `device_assigned`).

import { logAudit } from '../../core/lib/audit.js'
import { resolveGroupDeviceIds } from '../../groups/lib/groups.js'

// Une seule instruction : l'ancienne valeur est capturée par la sous-requête
// verrouillée. Retourne { before, after } ou null si le poste n'est pas pull.
export async function changeAssignment(db, log, actor, deviceId, { profile, ring }) {
  const { rows: [row] } = await db.query(`
    UPDATE devices d SET profile = COALESCE($2, d.profile), ring = COALESCE($3, d.ring)
    FROM (SELECT id, profile, ring FROM devices WHERE id = $1 AND managed_by = 'pull' FOR UPDATE) old
    WHERE d.id = old.id
    RETURNING old.profile AS before_profile, old.ring AS before_ring, d.profile, d.ring, d.hostname
  `, [deviceId, profile ?? null, ring ?? null])
  if (!row) return null
  const before = { profile: row.before_profile, ring: row.before_ring }
  const after = { profile: row.profile, ring: row.ring }
  if (before.profile !== after.profile || before.ring !== after.ring) {
    await logAudit(db, log, { action: 'linux_assignment_changed', byUser: actor, target: deviceId, details: { hostname: row.hostname, before, after } })
  }
  return { before, after }
}

// assign-bulk : ids ou membres effectifs d'un groupe natif ; les lignes non
// pull (ou inconnues) sont ignorées et comptées (BulkResult).
export async function assignBulk(db, log, actor, { ids = [], groupId, profile, ring }) {
  const targets = [...new Set(groupId ? await resolveGroupDeviceIds(db, groupId) : ids)]
  const result = { ok: 0, skipped: 0, errors: [] }
  const { rows } = await db.query('SELECT id, managed_by FROM devices WHERE id = ANY($1::uuid[])', [targets])
  for (const id of targets) {
    const device = rows.find(row => row.id === id)
    const code = !device ? 'NOT_FOUND' : device.managed_by !== 'pull' ? 'NOT_PULL_MANAGED' : null
    if (!code && await changeAssignment(db, log, actor, id, { profile, ring })) result.ok++
    else result.errors.push({ id, code: code ?? 'NOT_FOUND' })
  }
  result.skipped = result.errors.length
  return result
}
