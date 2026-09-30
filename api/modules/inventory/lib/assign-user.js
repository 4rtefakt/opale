import { logAudit } from '../../core/lib/audit.js'

export async function setAssignedUser(db, log, actor, deviceId, entraIdOrNull) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [device] } = await client.query('SELECT assigned_user_id FROM devices WHERE id = $1 FOR UPDATE', [deviceId])
    if (!device) {
      await client.query('ROLLBACK')
      return { ok: false, status: 404, code: 'NOT_FOUND' }
    }
    let user = null
    if (entraIdOrNull !== null) {
      const { rows } = await client.query('SELECT display_name FROM users_cache WHERE entra_id = $1', [entraIdOrNull])
      user = rows[0]
      if (!user) {
        await client.query('ROLLBACK')
        return { ok: false, status: 400, code: 'UNKNOWN_USER' }
      }
    }
    await client.query('UPDATE devices SET assigned_user_id = $2 WHERE id = $1', [deviceId, entraIdOrNull])
    await logAudit(client, log, {
      action: 'device_assigned', byUser: actor, target: deviceId,
      details: { before: device.assigned_user_id, after: entraIdOrNull },
    })
    await client.query('COMMIT')
    return { ok: true, id: deviceId, assigned_user_id: entraIdOrNull, assigned_user_name: user?.display_name ?? null }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
