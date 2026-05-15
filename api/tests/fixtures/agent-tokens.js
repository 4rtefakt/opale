// Seeds réutilisables pour agent_tokens (auth des agents Windows, distinct
// des JWT admin et des tokens CLI opl_).
//
// Le token retourné est le SECRET en clair (32 bytes hex). Le hash SHA-256
// est calculé et inséré côté DB. Mirror la convention de generateAgentToken
// dans agent-go/build.js.

import crypto from 'node:crypto'

export async function seedAgentToken(db, {
  deviceId = null,
  label = 'test-agent-token',
  isBootstrap = false,
  bootstrapMaxRedeems = null,
  bootstrapRedeemedCount = 0,
  expiresAt = null,
  revokedAt = null,
  createdBy = 'test',
} = {}) {
  const secret = crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(secret).digest('hex')
  const r = await db.query(
    `INSERT INTO agent_tokens (
       device_id, label, token_hash, is_bootstrap,
       bootstrap_max_redeems, bootstrap_redeemed_count,
       expires_at, revoked_at, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      deviceId, label, hash, isBootstrap,
      bootstrapMaxRedeems, bootstrapRedeemedCount,
      expiresAt, revokedAt, createdBy,
    ]
  )
  return { id: r.rows[0].id, secret, hash }
}
