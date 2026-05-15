// Tickets proposés : candidats à valider avant de devenir des vrais tickets.
// Sources : alert, script, email (IA), manual. Acceptation → INSERT dans tickets + lien.

const ALLOWED_SOURCES   = ['alert', 'script', 'email', 'manual']
const ALLOWED_PRIORITES = ['low', 'normal', 'high', 'critical']

export default async function ticketProposalsRoute(fastify) {

  // GET /api/ticket-proposals?status=pending
  // status par défaut : pending. Peut prendre 'all' pour tout, ou un statut précis.
  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { status = 'pending' } = req.query
    const limit  = Math.min(parseInt(req.query.limit  ?? 100, 10) || 100, 500)
    const offset = Math.max(parseInt(req.query.offset ?? 0,   10) || 0,    0)

    const conds  = []
    const params = []
    let i = 1
    if (status !== 'all') { conds.push(`p.status = $${i++}`); params.push(status) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    params.push(limit, offset)

    const { rows } = await fastify.db.query(`
      SELECT p.*,
             d.hostname AS device_hostname,
             u.display_name AS user_display_name, u.email AS user_email
      FROM ticket_proposals p
      LEFT JOIN devices d     ON d.id = p.suggested_device_id
      LEFT JOIN users_cache u ON u.entra_id = p.suggested_user_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${i} OFFSET $${i + 1}
    `, params)

    reply.send(rows)
  })

  // GET /api/ticket-proposals/count — compteur rapide pour le badge UI
  fastify.get('/count', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT COUNT(*)::int AS pending FROM ticket_proposals WHERE status = 'pending'`
    )
    reply.send({ pending: rows[0].pending })
  })

  // GET /api/ticket-proposals/:id
  fastify.get('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT p.*,
             d.hostname AS device_hostname,
             u.display_name AS user_display_name, u.email AS user_email
      FROM ticket_proposals p
      LEFT JOIN devices d     ON d.id = p.suggested_device_id
      LEFT JOIN users_cache u ON u.entra_id = p.suggested_user_id
      WHERE p.id = $1
    `, [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Proposition introuvable' })
    reply.send(rows[0])
  })

  // POST /api/ticket-proposals
  // Body : { source, suggested_title (req), suggested_description?, suggested_priority?,
  //          suggested_device_id?, suggested_user_id?,
  //          source_ref_type?, source_ref_id?, source_payload? }
  fastify.post('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const b = req.body || {}
    const source = b.source || 'manual'
    if (!ALLOWED_SOURCES.includes(source)) return reply.code(400).send({ error: 'source invalide' })
    if (!b.suggested_title?.trim())        return reply.code(400).send({ error: 'suggested_title requis' })
    const priority = b.suggested_priority || 'normal'
    if (!ALLOWED_PRIORITES.includes(priority)) return reply.code(400).send({ error: 'priorité invalide' })

    const { rows } = await fastify.db.query(`
      INSERT INTO ticket_proposals
        (source, source_ref_type, source_ref_id, source_payload,
         suggested_title, suggested_description, suggested_priority,
         suggested_device_id, suggested_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      source,
      b.source_ref_type || null,
      b.source_ref_id   || null,
      b.source_payload  ? JSON.stringify(b.source_payload) : null,
      b.suggested_title.trim(),
      b.suggested_description || null,
      priority,
      b.suggested_device_id || null,
      b.suggested_user_id   || null,
    ])
    reply.code(201).send(rows[0])
  })

  // POST /api/ticket-proposals/:id/accept
  // Body optionnel : surcharge des champs (title, description, priority, device_id, user_id, tag_ids)
  // Crée un ticket dans la table tickets, lie la proposition.
  fastify.post('/:id/accept', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { entraId, displayName } = fastify.getUserIdentity(req)
    const overrides = req.body || {}

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      const { rows: pRows } = await client.query(
        `SELECT * FROM ticket_proposals WHERE id = $1 FOR UPDATE`, [req.params.id]
      )
      if (!pRows.length)              { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Proposition introuvable' }) }
      const p = pRows[0]
      if (p.status !== 'pending')     { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Proposition déjà traitée', status: p.status }) }

      const title       = (overrides.title       ?? p.suggested_title).trim()
      const description = overrides.description  ?? p.suggested_description
      const priority    = overrides.priority     ?? p.suggested_priority
      const device_id   = overrides.device_id    ?? p.suggested_device_id
      const user_id     = overrides.user_id      ?? p.suggested_user_id
      const tag_ids     = Array.isArray(overrides.tag_ids) ? overrides.tag_ids : []
      if (!title)                                 { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'title requis' }) }
      if (!ALLOWED_PRIORITES.includes(priority))  { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'priorité invalide' }) }

      const { rows: tRows } = await client.query(`
        INSERT INTO tickets
          (title, description, priority, device_id, user_id, source, is_auto,
           created_by_entra_id, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)
        RETURNING *
      `, [title, description || null, priority, device_id || null, user_id || null,
          p.source, entraId, displayName])
      const tk = tRows[0]

      if (tag_ids.length) {
        const values = tag_ids.map((_, idx) => `($1, $${idx + 2})`).join(',')
        await client.query(
          `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [tk.id, ...tag_ids]
        )
      }

      await client.query(`
        UPDATE ticket_proposals SET
          status = 'accepted',
          ticket_id = $1,
          reviewed_by_entra_id = $2,
          reviewed_by_name = $3,
          reviewed_at = now()
        WHERE id = $4
      `, [tk.id, entraId, displayName, p.id])

      await client.query('COMMIT')
      reply.code(201).send({ ticket: tk, proposal_id: p.id })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // POST /api/ticket-proposals/:id/reject  { reason? }
  fastify.post('/:id/reject', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { entraId, displayName } = fastify.getUserIdentity(req)
    const reason = req.body?.reason || null

    const { rows } = await fastify.db.query(`
      UPDATE ticket_proposals SET
        status = 'rejected',
        rejected_reason = $1,
        reviewed_by_entra_id = $2,
        reviewed_by_name = $3,
        reviewed_at = now()
      WHERE id = $4 AND status = 'pending'
      RETURNING *
    `, [reason, entraId, displayName, req.params.id])

    if (!rows.length) return reply.code(409).send({ error: 'Proposition introuvable ou déjà traitée' })
    reply.send(rows[0])
  })
}
