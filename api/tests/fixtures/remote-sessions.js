// Fixtures réutilisables pour remote_sessions + remote_session_logs.

export async function seedRemoteSession(db, {
  deviceId,
  transport = 'agent_console',
  byEntraId = 'oid-admin',
  byName = 'Admin Test',
  endedAt = new Date().toISOString(),
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO remote_sessions (device_id, transport, by_entra_id, by_name, ended_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [deviceId, transport, byEntraId, byName, endedAt]
  )
  return rows[0]
}

export async function seedRemoteSessionLog(db, {
  sessionId,
  frames = [{ ts_ms: 0, direction: 'out', b64: 'aGVsbG8=' }],
  sizeBytes = 5,
  truncated = false,
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO remote_session_logs (session_id, frames, size_bytes, truncated)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [sessionId, JSON.stringify(frames), sizeBytes, truncated]
  )
  return rows[0]
}
