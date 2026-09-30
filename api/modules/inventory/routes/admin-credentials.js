import crypto from 'crypto'
import { logAudit } from '../../core/lib/audit.js'
// Clé privée LAPS partagée avec l'escrow Linux (lib/laps-key.js).
import { loadLAPSKey } from '../lib/laps-key.js'

export default async function adminCredentialsRoute(fastify) {

  // GET /api/admin-credentials/:device_id — récupère + déchiffre le password.
  // Exige authentification + droit admin. Chaque accès est audit logé.
  // L'API retourne le password EN CLAIR dans la réponse JSON ; le client
  // doit l'afficher en lecture-une-fois et idéalement déclencher une
  // rotation immédiate après usage (TODO frontend).
  fastify.get('/:device_id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const { device_id } = req.params

    const { rows } = await fastify.db.query(`
      SELECT c.*, d.hostname
      FROM device_admin_credentials c
      JOIN devices d ON d.id = c.device_id
      WHERE c.device_id = $1
    `, [device_id])
    if (!rows.length) {
      return reply.code(404).send({ error: 'Aucun credential pour ce device' })
    }
    const row = rows[0]

    let plain
    try {
      const key = loadLAPSKey()
      plain = crypto.privateDecrypt(
        { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        row.encrypted_password
      ).toString('utf8')
    } catch (err) {
      fastify.log.error({ err: err.message }, 'LAPS decrypt failed')
      return reply.code(500).send({ error: 'Décryption impossible côté serveur' })
    }

    const user = fastify.getUserIdentity(req)
    await fastify.db.query(`
      UPDATE device_admin_credentials
        SET last_viewed_at = now(), last_viewed_by = $1
      WHERE device_id = $2
    `, [user?.entraId || null, device_id])
    await logAudit(fastify.db, fastify.log, {
      action: 'laps_viewed',
      byUser: user?.email || user?.entraId || 'unknown',
      target: device_id,
      details: { hostname: row.hostname, username: row.username },
    })

    reply.send({
      device_id:           row.device_id,
      hostname:            row.hostname,
      username:            row.username,
      password:            plain,
      password_changed_at: row.password_changed_at,
      last_viewed_at:      row.last_viewed_at,
      last_viewed_by:      row.last_viewed_by,
    })
  })

  // POST /api/admin-credentials/:device_id/rotate — flag une rotation
  // au prochain checkin. (Le checkin agent ne consomme pas encore ce flag —
  // à câbler dans une pass suivante avec le frontend.)
  fastify.post('/:device_id/rotate', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    const { device_id } = req.params
    const result = await fastify.db.query(`
      UPDATE device_admin_credentials
         SET rotation_requested_at = now()
       WHERE device_id = $1
      RETURNING device_id
    `, [device_id])
    if (!result.rows.length) {
      return reply.code(404).send({ error: 'Aucun credential pour ce device' })
    }
    const user = fastify.getUserIdentity(req)
    await logAudit(fastify.db, fastify.log, {
      action: 'laps_rotation_requested',
      byUser: user?.email || user?.entraId || 'unknown',
      target: device_id,
    })
    reply.code(202).send({ status: 'queued' })
  })
}
