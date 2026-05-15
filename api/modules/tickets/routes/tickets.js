// Couleurs autorisées pour les tags : palette fermée alignée avec le front.
const TAG_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet', 'pink', 'teal']
const PRIORITIES = ['low', 'normal', 'high', 'critical']

function parseCsv(v) {
  if (!v) return null
  return String(v).split(',').map(s => s.trim()).filter(Boolean)
}

function parseDate(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Charge les tags pour une liste d'ids de tickets, retourne une Map(ticketId → tags[])
async function loadTagsFor(db, ticketIds) {
  if (!ticketIds.length) return new Map()
  const { rows } = await db.query(`
    SELECT tt.ticket_id, g.id, g.name, g.color
    FROM ticket_tags tt
    JOIN tags g ON g.id = tt.tag_id
    WHERE tt.ticket_id = ANY($1)
    ORDER BY g.name
  `, [ticketIds])
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.ticket_id)) map.set(r.ticket_id, [])
    map.get(r.ticket_id).push({ id: r.id, name: r.name, color: r.color })
  }
  return map
}

// Vérifie l'accès à un ticket : admin OU requester (user_id) OU assignee
// (assigned_to_entra_id). Renvoie l'identité résolue + le flag isAdmin pour
// éviter une seconde requête. Si pas d'accès, répond 403/404 et renvoie null.
async function checkTicketAccess(fastify, request, reply, ticketId) {
  const { rows } = await fastify.db.query(
    'SELECT user_id, assigned_to_entra_id FROM tickets WHERE id = $1', [ticketId]
  )
  if (!rows.length) { reply.code(404).send({ error: 'Ticket introuvable' }); return null }
  const isAdmin = await fastify.isAdmin(request)
  const identity = fastify.getUserIdentity(request)
  if (!isAdmin
      && rows[0].user_id !== identity.entraId
      && rows[0].assigned_to_entra_id !== identity.entraId) {
    reply.code(403).send({ error: 'Non autorisé' })
    return null
  }
  return { isAdmin, ...identity }
}

export default async function ticketsRoute(fastify) {

  // ───────────────────────────────────────────────────────────────────────────
  // Routes statiques — déclarées AVANT /:id pour ne pas être confondues
  // avec un identifiant par Fastify.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/tickets/count — tickets ouverts non encore pris en charge (badge sidebar)
  // Admin-only : un non-admin ne s'auto-assignerait pas de tickets non assignés.
  fastify.get('/count', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT COUNT(*)::int AS open
       FROM tickets
       WHERE status = 'open' AND assigned_to_entra_id IS NULL`
    )
    reply.send(rows[0])
  })

  // GET /api/tickets/tags
  fastify.get('/tags', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      'SELECT id, name, color, created_at FROM tags ORDER BY name'
    )
    reply.send(rows)
  })

  // POST /api/tickets/tags  { name, color? }
  fastify.post('/tags', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const name  = String(req.body?.name || '').trim()
    const color = String(req.body?.color || 'slate').trim()
    if (!name)                          return reply.code(400).send({ error: 'Nom requis' })
    if (!TAG_COLORS.includes(color))    return reply.code(400).send({ error: 'Couleur invalide' })
    if (name.length > 40)               return reply.code(400).send({ error: 'Nom trop long (40 max)' })

    try {
      const { rows } = await fastify.db.query(
        'INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at',
        [name, color]
      )
      reply.code(201).send(rows[0])
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'Ce tag existe déjà' })
      throw err
    }
  })

  // DELETE /api/tickets/tags/:id  (cascade vers ticket_tags)
  fastify.delete('/tags/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rowCount } = await fastify.db.query('DELETE FROM tags WHERE id = $1', [req.params.id])
    if (!rowCount) return reply.code(404).send({ error: 'Tag introuvable' })
    reply.code(204).send()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Tickets
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/tickets
  // Paramètres : status, device_id, q, priority (csv), assigned_to (entra_id|me|unassigned),
  //              tag (csv tag_ids, AND), created_from/created_to (ISO), is_auto, limit, offset
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const {
      status, device_id, q, priority, assigned_to, tag,
      created_from, created_to, is_auto,
    } = req.query

    const limit  = Math.min(parseInt(req.query.limit  ?? 50, 10) || 50, 200)
    const offset = Math.max(parseInt(req.query.offset ?? 0,  10) || 0,   0)

    const conds = []
    const params = []
    let i = 1

    // ACL : un non-admin ne voit que ses propres tickets (requester ou assignee).
    const isAdmin = await fastify.isAdmin(req)
    if (!isAdmin) {
      const { entraId } = fastify.getUserIdentity(req)
      conds.push(`(t.user_id = $${i} OR t.assigned_to_entra_id = $${i})`)
      params.push(entraId); i++
    }

    if (status)    { conds.push(`t.status = $${i++}`);    params.push(status) }
    if (device_id) { conds.push(`t.device_id = $${i++}`); params.push(device_id) }
    if (q) {
      // Recherche : titre, description, ET messages (commentaires/résolutions)
      conds.push(`(
        t.title ILIKE $${i} OR t.description ILIKE $${i}
        OR EXISTS (
          SELECT 1 FROM ticket_messages tm
          WHERE tm.ticket_id = t.id
            AND tm.type != 'system'
            AND tm.content ILIKE $${i}
        )
      )`)
      params.push(`%${q}%`); i++
    }
    if (is_auto === 'true' || is_auto === 'false') {
      conds.push(`t.is_auto = $${i++}`); params.push(is_auto === 'true')
    }

    const prios = parseCsv(priority)?.filter(p => PRIORITIES.includes(p))
    if (prios?.length) { conds.push(`t.priority = ANY($${i++})`); params.push(prios) }

    if (assigned_to === 'me') {
      const { entraId } = fastify.getUserIdentity(req)
      conds.push(`t.assigned_to_entra_id = $${i++}`); params.push(entraId)
    } else if (assigned_to === 'unassigned') {
      conds.push(`t.assigned_to_entra_id IS NULL`)
    } else if (assigned_to) {
      conds.push(`t.assigned_to_entra_id = $${i++}`); params.push(assigned_to)
    }

    const tagIds = parseCsv(tag)
    if (tagIds?.length) {
      // AND : ticket doit posséder TOUS les tags listés
      conds.push(`(
        SELECT COUNT(*) FROM ticket_tags tt
        WHERE tt.ticket_id = t.id AND tt.tag_id = ANY($${i})
      ) = $${i + 1}`)
      params.push(tagIds, tagIds.length)
      i += 2
    }

    const fromIso = parseDate(created_from)
    const toIso   = parseDate(created_to)
    if (fromIso) { conds.push(`t.created_at >= $${i++}`); params.push(fromIso) }
    if (toIso)   { conds.push(`t.created_at <= $${i++}`); params.push(toIso) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const { displayName: meName } = fastify.getUserIdentity(req)
    params.push(meName, limit, offset)
    const meIdx = i

    // awaiting_reply : ticket open/in_progress dont le dernier message non-system n'est pas de moi
    const { rows } = await fastify.db.query(`
      SELECT t.*, d.hostname, d.assigned_user_id AS assigned_user,
             u.display_name AS requester_name, u.email AS requester_email,
             CASE
               WHEN t.status IN ('open','in_progress')
                AND lm.author IS NOT NULL
                AND lm.author <> $${meIdx}
               THEN true ELSE false
             END AS awaiting_reply
      FROM tickets t
      LEFT JOIN devices d     ON d.id = t.device_id
      LEFT JOIN users_cache u ON u.entra_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT author FROM ticket_messages
        WHERE ticket_id = t.id AND type <> 'system'
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      ${where}
      ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
      LIMIT $${i + 1} OFFSET $${i + 2}
    `, params)

    const tagMap = await loadTagsFor(fastify.db, rows.map(r => r.id))
    for (const r of rows) r.tags = tagMap.get(r.id) || []

    reply.send(rows)
  })

  // POST /api/tickets
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const {
      title, description, priority = 'normal', device_id,
      source = 'manual',
      assigned_to_entra_id, assigned_to_name,
      user_id,
      tag_ids,
    } = req.body || {}
    if (!title) return reply.code(400).send({ error: 'Titre requis' })

    const { entraId, displayName } = fastify.getUserIdentity(req)

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`
        INSERT INTO tickets
          (title, description, priority, device_id, user_id, source, is_auto,
           created_by_entra_id, created_by_name,
           assigned_to_entra_id, assigned_to_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        title, description || null, priority, device_id || null, user_id || null, source,
        source === 'auto', entraId, displayName,
        assigned_to_entra_id || null, assigned_to_name || null,
      ])
      const tk = rows[0]

      if (Array.isArray(tag_ids) && tag_ids.length) {
        const values = tag_ids.map((_, idx) => `($1, $${idx + 2})`).join(',')
        await client.query(
          `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [tk.id, ...tag_ids]
        )
      }

      await client.query('COMMIT')

      // Re-fetch avec le requester pour cohérence avec GET
      if (tk.user_id) {
        const { rows: ur } = await fastify.db.query(
          'SELECT display_name, email FROM users_cache WHERE entra_id = $1',
          [tk.user_id]
        )
        if (ur[0]) { tk.requester_name = ur[0].display_name; tk.requester_email = ur[0].email }
      }

      const tagMap = await loadTagsFor(fastify.db, [tk.id])
      tk.tags = tagMap.get(tk.id) || []
      reply.code(201).send(tk)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // GET /api/tickets/:id — admin OU requester OU assignee
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { displayName: meName } = acl
    const { rows: tRows } = await fastify.db.query(`
      SELECT t.*, d.hostname, d.assigned_user_id AS assigned_user,
             u.display_name AS requester_name, u.email AS requester_email,
             CASE
               WHEN t.status IN ('open','in_progress')
                AND lm.author IS NOT NULL
                AND lm.author <> $2
               THEN true ELSE false
             END AS awaiting_reply
      FROM tickets t
      LEFT JOIN devices d     ON d.id = t.device_id
      LEFT JOIN users_cache u ON u.entra_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT author FROM ticket_messages
        WHERE ticket_id = t.id AND type <> 'system'
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      WHERE t.id = $1
    `, [req.params.id, meName])

    if (!tRows.length) return reply.code(404).send({ error: 'Ticket introuvable' })

    const { rows: msgs } = await fastify.db.query(`
      SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC
    `, [req.params.id])

    const tagMap = await loadTagsFor(fastify.db, [req.params.id])
    const tk = tRows[0]
    tk.tags = tagMap.get(tk.id) || []
    tk.messages = msgs
    reply.send(tk)
  })

  // PATCH /api/tickets/:id — admin OU requester OU assignee
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { status, priority, assigned_to_entra_id, assigned_to_name, user_id, device_id } = req.body || {}
    const { displayName } = acl

    const { rows: existing } = await fastify.db.query('SELECT status FROM tickets WHERE id = $1', [req.params.id])
    if (!existing.length) return reply.code(404).send({ error: 'Ticket introuvable' })

    const fields = []
    const params = []
    let i = 1

    if (status !== undefined)               { fields.push(`status = $${i++}`);               params.push(status) }
    if (priority !== undefined)             { fields.push(`priority = $${i++}`);             params.push(priority) }
    if (assigned_to_entra_id !== undefined) { fields.push(`assigned_to_entra_id = $${i++}`); params.push(assigned_to_entra_id) }
    if (assigned_to_name !== undefined)     { fields.push(`assigned_to_name = $${i++}`);     params.push(assigned_to_name) }
    if (user_id !== undefined)              { fields.push(`user_id = $${i++}`);              params.push(user_id) }
    if (device_id !== undefined)            { fields.push(`device_id = $${i++}`);            params.push(device_id) }
    if (status === 'resolved')              { fields.push(`resolved_at = $${i++}`);          params.push(new Date()) }

    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })

    params.push(req.params.id)
    const { rows } = await fastify.db.query(`
      UPDATE tickets SET ${fields.join(', ')}, updated_at = now()
      WHERE id = $${i} RETURNING *
    `, params)

    // Message système si changement de statut
    if (status && status !== existing[0].status) {
      const label = status === 'resolved'    ? 'Ticket résolu'
                  : status === 'in_progress' ? 'Ticket pris en charge'
                  : status === 'open'        ? 'Ticket réouvert'
                  : status

      await fastify.db.query(`
        INSERT INTO ticket_messages (ticket_id, type, author, content)
        VALUES ($1, 'system', $2, $3)
      `, [req.params.id, displayName, label])
    }

    reply.send(rows[0])
  })

  // POST /api/tickets/:id/messages — admin OU requester OU assignee
  fastify.post('/:id/messages', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { content, type = 'comment' } = req.body || {}
    if (!content) return reply.code(400).send({ error: 'Contenu requis' })

    const { displayName } = acl
    const { rows } = await fastify.db.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.params.id, type, displayName, content])

    await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(201).send(rows[0])
  })

  // POST /api/tickets/:id/tags  { tag_id }
  fastify.post('/:id/tags', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const tag_id = req.body?.tag_id
    if (!tag_id) return reply.code(400).send({ error: 'tag_id requis' })

    try {
      await fastify.db.query(
        `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.params.id, tag_id]
      )
      await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
      reply.code(201).send({ ok: true })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ error: 'Ticket ou tag introuvable' })
      throw err
    }
  })

  // DELETE /api/tickets/:id/tags/:tagId
  fastify.delete('/:id/tags/:tagId', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    await fastify.db.query(
      'DELETE FROM ticket_tags WHERE ticket_id = $1 AND tag_id = $2',
      [req.params.id, req.params.tagId]
    )
    await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(204).send()
  })
}
