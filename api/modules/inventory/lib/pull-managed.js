export const NOT_PULL_MANAGED_SQL = "managed_by IS DISTINCT FROM 'pull'"

export async function isPullManaged(db, deviceId) {
  const { rows } = await db.query('SELECT managed_by FROM devices WHERE id = $1', [deviceId])
  return rows[0]?.managed_by === 'pull'
}

export async function filterPullManaged(db, ids) {
  const { rows } = await db.query(`SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND ${NOT_PULL_MANAGED_SQL}`, [ids])
  const allowed = new Set(rows.map(row => row.id))
  const kept = ids.filter(id => allowed.has(id))
  return { kept, skipped: ids.length - kept.length }
}
