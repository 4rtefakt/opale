// Points informatiques — CRUD des revues périodiques (cf. migration 078).
//
// Le document est volontairement « bête » côté serveur : snapshot et sections
// sont des JSONB opaques assemblés/édités par le front. Le serveur ne fait que
// persister, lister et servir (avec traçabilité de l'auteur). La logique
// d'agrégation des métriques reste dans les endpoints existants (dashboard /
// email / rapports), que le front interroge avant de figer le snapshot.

import { logAudit } from '../../core/lib/audit.js'

export default async function reviewsRoute(fastify) {

  // GET /api/reviews — liste (sans le corps snapshot/sections, pour rester léger)
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT id, title, period_start, period_end, created_by_name, created_at, updated_at,
             jsonb_array_length(sections) AS section_count
      FROM reviews
      ORDER BY COALESCE(period_end, created_at::date) DESC, created_at DESC
    `)
    reply.send(rows)
  })

  // GET /api/reviews/:id — document complet
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.db.query('SELECT * FROM reviews WHERE id = $1', [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Point introuvable' })
    reply.send(rows[0])
  })

  // POST /api/reviews — { title, period_start?, period_end?, snapshot?, sections? }
  fastify.post('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const b = req.body || {}
    const title = String(b.title || '').trim()
    if (!title) return reply.code(400).send({ error: 'Titre requis' })

    const { entraId, displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      INSERT INTO reviews
        (title, period_start, period_end, snapshot, sections, created_by_entra_id, created_by_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      title,
      b.period_start || null,
      b.period_end   || null,
      JSON.stringify(b.snapshot ?? {}),
      JSON.stringify(Array.isArray(b.sections) ? b.sections : []),
      entraId, displayName,
    ])
    logAudit(fastify.db, fastify.log, { action: 'review_created', byUser: displayName || entraId, target: title })
    reply.code(201).send(rows[0])
  })

  // PATCH /api/reviews/:id — mise à jour partielle
  fastify.patch('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const b = req.body || {}
    const fields = []
    const params = []
    let i = 1

    if (b.title !== undefined) {
      const title = String(b.title).trim()
      if (!title) return reply.code(400).send({ error: 'Titre vide' })
      fields.push(`title = $${i++}`); params.push(title)
    }
    if (b.period_start !== undefined) { fields.push(`period_start = $${i++}`); params.push(b.period_start || null) }
    if (b.period_end   !== undefined) { fields.push(`period_end = $${i++}`);   params.push(b.period_end   || null) }
    if (b.snapshot     !== undefined) { fields.push(`snapshot = $${i++}`);     params.push(JSON.stringify(b.snapshot ?? {})) }
    if (b.sections     !== undefined) { fields.push(`sections = $${i++}`);     params.push(JSON.stringify(Array.isArray(b.sections) ? b.sections : [])) }

    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })

    params.push(req.params.id)
    const { rows } = await fastify.db.query(
      `UPDATE reviews SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
      params
    )
    if (!rows.length) return reply.code(404).send({ error: 'Point introuvable' })
    reply.send(rows[0])
  })

  // DELETE /api/reviews/:id
  fastify.delete('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rowCount } = await fastify.db.query('DELETE FROM reviews WHERE id = $1', [req.params.id])
    if (!rowCount) return reply.code(404).send({ error: 'Point introuvable' })
    reply.code(204).send()
  })
}
