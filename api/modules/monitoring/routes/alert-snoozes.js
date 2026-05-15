// Snooze d'alertes par (device, alert_type) avec date d'expiration.
// Convention : on conserve un seul snooze actif par couple (UNIQUE en DB) ;
// l'historique des décisions est tracé via audit_logs.

import { logAudit } from '../../core/lib/audit.js'

const ALLOWED_TYPES = ['disk_critical', 'disk_high', 'noncompliant', 'offline']

export default async function alertSnoozesRoute(fastify) {

  // GET /api/alert-snoozes — snoozes actifs (until_at > now()), avec hostname
  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT s.id, s.device_id, s.alert_type, s.until_at, s.reason,
             s.created_by_entra_id, s.created_by_name, s.created_at,
             d.hostname
      FROM alert_snoozes s
      JOIN devices d ON d.id = s.device_id
      WHERE s.until_at > now()
      ORDER BY s.until_at ASC
    `)
    reply.send(rows)
  })

  // POST /api/alert-snoozes  { device_id, alert_type, until_at (ISO), reason? }
  // Upsert : remplace le snooze existant pour le même couple device+type.
  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['device_id', 'alert_type', 'until_at'],
        properties: {
          device_id:  { type: 'string', minLength: 1 },
          alert_type: { type: 'string', enum: ALLOWED_TYPES },
          until_at:   { type: 'string' },
          reason:     { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { entraId, displayName } = fastify.getUserIdentity(req) || {}
    const b = req.body
    // device_id, alert_type validés par schéma (requis + enum)

    const until = new Date(b.until_at)
    if (Number.isNaN(until.getTime()) || until <= new Date()) {
      return reply.code(400).send({ error: 'until_at invalide ou dans le passé' })
    }

    const reason = (b.reason || '').toString().trim() || null

    const { rows } = await fastify.db.query(`
      INSERT INTO alert_snoozes
        (device_id, alert_type, until_at, reason, created_by_entra_id, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (device_id, alert_type) DO UPDATE SET
        until_at            = EXCLUDED.until_at,
        reason              = EXCLUDED.reason,
        created_by_entra_id = EXCLUDED.created_by_entra_id,
        created_by_name     = EXCLUDED.created_by_name,
        created_at          = now()
      RETURNING *
    `, [b.device_id, b.alert_type, until.toISOString(), reason, entraId || null, displayName || null])

    logAudit(fastify.db, fastify.log, {
      action: 'alert_snooze',
      byUser: displayName || entraId || 'unknown',
      target: b.device_id,
      details: { alert_type: b.alert_type, until_at: until.toISOString(), reason },
    })

    reply.code(201).send(rows[0])
  })

  // DELETE /api/alert-snoozes/:id — annule un snooze (le device repasse en alerte)
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { entraId, displayName } = fastify.getUserIdentity(req) || {}
    const { rows } = await fastify.db.query(
      'DELETE FROM alert_snoozes WHERE id = $1 RETURNING device_id, alert_type',
      [req.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Snooze introuvable' })

    logAudit(fastify.db, fastify.log, {
      action: 'alert_unsnooze',
      byUser: displayName || entraId || 'unknown',
      target: rows[0].device_id,
      details: { alert_type: rows[0].alert_type },
    })

    reply.code(204).send()
  })
}
