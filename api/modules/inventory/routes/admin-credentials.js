import crypto from 'crypto'
import { logAudit, insertAudit } from '../../core/lib/audit.js'
// Clé privée LAPS partagée avec l'escrow Linux (lib/laps-key.js).
import { loadLAPSKey } from '../lib/laps-key.js'
// Contrat uniforme Windows/Linux : schéma (motif requis) tiré de la spec du module linux.
import { schemaFor } from '../../linux/lib/spec.js'

export default async function adminCredentialsRoute(fastify) {

  // POST /api/admin-credentials/:deviceId/reveal — récupère + déchiffre le
  // password. Session interactive admin et motif obligatoires. Fail-closed :
  // la ligne d'audit `laps_viewed` (avec le motif) et last_viewed_* sont
  // validées dans une transaction AVANT l'envoi du secret ; si ce commit
  // échoue, rien ne part. L'API retourne le password EN CLAIR dans la
  // réponse JSON ; le client l'affiche en lecture-une-fois (30 s).
  fastify.post('/:deviceId/reveal', {
    schema: schemaFor('revealAdminCredential'),
    preHandler: [fastify.authenticate, fastify.requireAdmin, fastify.requireInteractive],
    config: { operationId: 'revealAdminCredential', rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { deviceId } = req.params

    const { rows } = await fastify.db.query(`
      SELECT c.*, d.hostname
      FROM device_admin_credentials c
      JOIN devices d ON d.id = c.device_id
      WHERE c.device_id = $1
    `, [deviceId])
    if (!rows.length) {
      return reply.code(404).send({ error: 'Aucun credential pour ce device' })
    }
    const row = rows[0]
    const user = fastify.getUserIdentity(req)
    const byUser = user?.email || user?.entraId || 'unknown'
    const details = { hostname: row.hostname, username: row.username, reason: req.body.reason }

    let plain
    try {
      const key = loadLAPSKey()
      plain = crypto.privateDecrypt(
        { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        row.encrypted_password
      ).toString('utf8')
    } catch (err) {
      fastify.log.error({ err: err.message }, 'LAPS decrypt failed')
      await logAudit(fastify.db, fastify.log, { action: 'laps_viewed', byUser, target: deviceId, details: { ...details, outcome: 'failed' } })
      return reply.code(500).send({ error: 'Décryption impossible côté serveur', code: 'DECRYPT_FAILED' })
    }

    // INSERT direct (insertAudit) et non logAudit : logAudit avale les erreurs
    // d'écriture, ce qui laisserait partir le mot de passe sans trace.
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await insertAudit(client, { action: 'laps_viewed', byUser, target: deviceId, details: { ...details, outcome: 'ok' } })
      await client.query(`
        UPDATE device_admin_credentials
          SET last_viewed_at = now(), last_viewed_by = $1
        WHERE device_id = $2
      `, [user?.entraId || null, deviceId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fastify.log.error({ err: err.message }, 'Trace d’audit impossible : mot de passe non révélé')
      return reply.code(500).send({ error: 'Trace d’audit impossible : secret non révélé', code: 'AUDIT_FAILED' })
    } finally {
      client.release()
    }

    reply.send({
      username:            row.username,
      password:            plain,
      password_changed_at: row.password_changed_at,
    })
  })

  // POST /api/admin-credentials/:device_id/rotate — flag une rotation
  // au prochain checkin (consommé par les agents Windows et Linux).
  fastify.post('/:device_id/rotate', {
    preHandler: [fastify.authenticate, fastify.requireAdmin, fastify.requireInteractive]
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
