// Demandes de matériel et commandes : suivi dédié, à part des tickets.
// Toutes les routes sont admin-only, comme le stock.

import { logAudit } from '../../core/lib/audit.js'
import { STATUSES, CLOSED_STATUSES, PRIORITIES } from '../lib/statuses.js'

// Pattern JSON Schema (Ajv ignore les drapeaux d'une RegExp : casse explicite).
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const nullableString = (max) => ({ type: ['string', 'null'], maxLength: max })
const nullableDate   = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

// Champs modifiables (POST et PATCH). title / status / priority ne sont pas
// nullables ; les autres se vident avec null.
const FIELDS = {
  title:              { type: 'string', minLength: 1, maxLength: 300 },
  category:           nullableString(100),
  status:             { type: 'string', enum: STATUSES },
  priority:           { type: 'string', enum: PRIORITIES },
  requester_entra_id: nullableString(100),
  requester_label:    nullableString(200),
  ticket_id:          { type: ['string', 'null'], pattern: UUID_PATTERN },
  requested_at:       nullableDate,
  planned_for:        nullableDate,
  next_action:        nullableString(1000),
  supplier:           nullableString(200),
  order_ref:          nullableString(100),
  amount_eur:         { type: ['number', 'null'], minimum: 0, maximum: 99999999 },
  budget_code:        nullableString(100),
  ordered_at:         nullableDate,
  received_at:        nullableDate,
  notes:              nullableString(5000),
}

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  required: ['id'],
}

const SELECT_REQUEST = `
  SELECT r.*,
         u.display_name AS requester_name,
         t.title        AS ticket_title,
         t.status       AS ticket_status
  FROM hardware_requests r
  LEFT JOIN users_cache u ON u.entra_id = r.requester_entra_id
  LEFT JOIN tickets t     ON t.id = r.ticket_id`

// Vérifie les références (demandeur, ticket) : 400 clair plutôt qu'une
// erreur de clé étrangère.
async function checkRefs(fastify, body) {
  if (body.requester_entra_id) {
    const { rows } = await fastify.db.query('SELECT 1 FROM users_cache WHERE entra_id = $1', [body.requester_entra_id])
    if (!rows.length) throw fastify.httpErrors.badRequest('Demandeur introuvable dans l\'annuaire')
  }
  if (body.ticket_id) {
    const { rows } = await fastify.db.query('SELECT 1 FROM tickets WHERE id = $1', [body.ticket_id])
    if (!rows.length) throw fastify.httpErrors.badRequest('Ticket introuvable')
  }
}

async function loadRequest(db, id) {
  const { rows } = await db.query(`${SELECT_REQUEST} WHERE r.id = $1`, [id])
  return rows[0] || null
}

export default async function hardwareRequestsRoute(fastify) {
  const guard = [fastify.authenticate, fastify.requireAdmin]

  // GET /api/hardware-requests?state=open|closed|all&q=
  fastify.get('/', {
    preHandler: guard,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'all' },
          q:     { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const { state, q } = req.query
    const conds = []
    const params = []
    if (state === 'open')   { params.push(CLOSED_STATUSES); conds.push(`r.status <> ALL($${params.length})`) }
    if (state === 'closed') { params.push(CLOSED_STATUSES); conds.push(`r.status = ANY($${params.length})`) }
    if (q) {
      params.push(`%${q}%`)
      const p = `$${params.length}`
      conds.push(`(r.title ILIKE ${p} OR r.category ILIKE ${p} OR r.requester_label ILIKE ${p}
                   OR u.display_name ILIKE ${p} OR r.supplier ILIKE ${p} OR r.order_ref ILIKE ${p})`)
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const { rows } = await fastify.db.query(`${SELECT_REQUEST} ${where}
      ORDER BY (r.status = ANY('{done,cancelled}')) ASC,
               r.planned_for ASC NULLS LAST,
               r.requested_at ASC NULLS LAST,
               r.created_at ASC`, params)
    return rows
  })

  // GET /api/hardware-requests/:id — la demande et son historique.
  fastify.get('/:id', { preHandler: guard, schema: { params: idParams } }, async (req) => {
    const request = await loadRequest(fastify.db, req.params.id)
    if (!request) throw fastify.httpErrors.notFound('Demande introuvable')
    const { rows: events } = await fastify.db.query(
      `SELECT * FROM hardware_request_events WHERE request_id = $1 ORDER BY created_at DESC, id`,
      [req.params.id]
    )
    return { ...request, events }
  })

  // POST /api/hardware-requests
  fastify.post('/', {
    preHandler: guard,
    schema: {
      body: { type: 'object', required: ['title'], properties: FIELDS, additionalProperties: false },
    },
  }, async (req, reply) => {
    const body = req.body
    await checkRefs(fastify, body)
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const by = displayName || entraId

    const cols = Object.keys(FIELDS).filter(k => body[k] !== undefined)
    const values = cols.map(k => body[k])
    cols.push('created_by_name'); values.push(by)
    if (CLOSED_STATUSES.includes(body.status)) { cols.push('closed_at'); values.push(new Date()) }

    const client = await fastify.db.connect()
    let id
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO hardware_requests (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, status`, values)
      id = rows[0].id
      await client.query(
        `INSERT INTO hardware_request_events (request_id, kind, to_status, by_name) VALUES ($1, 'created', $2, $3)`,
        [id, rows[0].status, by])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    await logAudit(fastify.db, fastify.log, {
      action: 'hardware_request_created', byUser: by, target: id, details: { title: body.title },
    })
    reply.code(201)
    return loadRequest(fastify.db, id)
  })

  // PATCH /api/hardware-requests/:id
  fastify.patch('/:id', {
    preHandler: guard,
    schema: {
      params: idParams,
      body: { type: 'object', properties: FIELDS, additionalProperties: false, minProperties: 1 },
    },
  }, async (req) => {
    const body = req.body
    await checkRefs(fastify, body)
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const by = displayName || entraId

    const client = await fastify.db.connect()
    let changed
    try {
      await client.query('BEGIN')
      const { rows: cur } = await client.query(
        'SELECT status FROM hardware_requests WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!cur.length) throw fastify.httpErrors.notFound('Demande introuvable')
      const from = cur[0].status

      const cols = Object.keys(FIELDS).filter(k => body[k] !== undefined)
      const sets = cols.map((k, i) => `${k} = $${i + 1}`)
      const values = cols.map(k => body[k])
      const statusChanged = body.status !== undefined && body.status !== from
      if (statusChanged) {
        sets.push(CLOSED_STATUSES.includes(body.status) ? 'closed_at = COALESCE(closed_at, now())' : 'closed_at = NULL')
      }
      values.push(req.params.id)
      await client.query(
        `UPDATE hardware_requests SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values)
      if (statusChanged) {
        await client.query(
          `INSERT INTO hardware_request_events (request_id, kind, from_status, to_status, by_name)
           VALUES ($1, 'status', $2, $3, $4)`, [req.params.id, from, body.status, by])
      }
      await client.query('COMMIT')
      changed = cols
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    await logAudit(fastify.db, fastify.log, {
      action: 'hardware_request_updated', byUser: by, target: req.params.id, details: { fields: changed },
    })
    return loadRequest(fastify.db, req.params.id)
  })

  // POST /api/hardware-requests/:id/reminders — le demandeur a relancé.
  fastify.post('/:id/reminders', {
    preHandler: guard,
    schema: {
      params: idParams,
      body: {
        type: 'object',
        properties: { note: { type: 'string', maxLength: 1000 }, date: nullableDate },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const { note, date } = req.body || {}
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const { rowCount } = await fastify.db.query(
      `UPDATE hardware_requests
       SET reminder_count = reminder_count + 1,
           last_reminder_at = GREATEST(last_reminder_at, COALESCE($2::date, CURRENT_DATE)),
           updated_at = now()
       WHERE id = $1`, [req.params.id, date || null])
    if (!rowCount) throw fastify.httpErrors.notFound('Demande introuvable')
    await fastify.db.query(
      `INSERT INTO hardware_request_events (request_id, kind, note, by_name) VALUES ($1, 'reminder', $2, $3)`,
      [req.params.id, note || null, displayName || entraId])
    return loadRequest(fastify.db, req.params.id)
  })

  // POST /api/hardware-requests/:id/notes
  fastify.post('/:id/notes', {
    preHandler: guard,
    schema: {
      params: idParams,
      body: {
        type: 'object', required: ['note'],
        properties: { note: { type: 'string', minLength: 1, maxLength: 2000 } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const { rows: exists } = await fastify.db.query('SELECT 1 FROM hardware_requests WHERE id = $1', [req.params.id])
    if (!exists.length) throw fastify.httpErrors.notFound('Demande introuvable')
    const { rows } = await fastify.db.query(
      `INSERT INTO hardware_request_events (request_id, kind, note, by_name)
       VALUES ($1, 'note', $2, $3) RETURNING *`, [req.params.id, req.body.note, displayName || entraId])
    await fastify.db.query('UPDATE hardware_requests SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(201)
    return rows[0]
  })

  // DELETE /api/hardware-requests/:id — saisie erronée (sinon : statut « annulée »).
  fastify.delete('/:id', { preHandler: guard, schema: { params: idParams } }, async (req, reply) => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(
      'DELETE FROM hardware_requests WHERE id = $1 RETURNING title', [req.params.id])
    if (!rows.length) throw fastify.httpErrors.notFound('Demande introuvable')
    await logAudit(fastify.db, fastify.log, {
      action: 'hardware_request_deleted', byUser: displayName || entraId, target: req.params.id,
      details: { title: rows[0].title },
    })
    reply.code(204)
    return null
  })
}
