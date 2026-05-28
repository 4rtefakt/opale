// Tickets proposés : candidats à valider avant de devenir des vrais tickets.
// Sources : alert, script, email (IA), manual. Acceptation → INSERT dans tickets + lien.

import { syncRequester, addDeviceToTicket } from '../lib/relations.js'

const ALLOWED_SOURCES   = ['alert', 'script', 'email', 'manual']
const ALLOWED_PRIORITES = ['low', 'normal', 'high', 'critical']

// Format de date court FR pour l'affichage dans la description du ticket
// ("Mail de X reçu le 5 février 2026 à 14h30"). Pas de dépendance externe :
// Intl.DateTimeFormat est dispo nativement.
const DATE_FMT_FR = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})
function formatDateFr(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return DATE_FMT_FR.format(d).replace(':', 'h')
}

// Pour les proposals legacy (avant Phase 1a), source_payload.bodyText n'existe
// pas mais suggested_description contient "De: X\nSujet: Y\n\n<body>".
// On extrait le body en strippant les 3 premières lignes si on reconnaît
// le format. Sinon on retourne la description telle quelle.
function extractBodyFromLegacyDescription(desc) {
  if (!desc) return ''
  const lines = desc.split('\n')
  if (lines[0]?.startsWith('De:') && lines[1]?.startsWith('Sujet:') && lines[2] === '') {
    return lines.slice(3).join('\n').trim()
  }
  return desc
}

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
      const priority    = overrides.priority     ?? p.suggested_priority
      const device_id   = overrides.device_id    ?? p.suggested_device_id
      const user_id     = overrides.user_id      ?? p.suggested_user_id
      const tag_ids     = Array.isArray(overrides.tag_ids) ? overrides.tag_ids : []
      if (!title)                                 { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'title requis' }) }
      if (!ALLOWED_PRIORITES.includes(priority))  { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'priorité invalide' }) }

      // Phase 1a — "Le ticket est une conversation".
      // Si la proposition vient d'un mail, on transforme le body en premier
      // ticket_message au lieu de l'enfouir dans tickets.description. La
      // description devient une ligne d'origine ("Mail de X reçu le Y") ; le
      // body et les éventuelles relances ("replies") deviennent des messages
      // dans le fil. email_sent_at=NOW() empêche l'outbox de les ré-envoyer.
      const messagesToInsert = [] // [{ author, content, createdAt }]
      let description = overrides.description ?? p.suggested_description
      if (p.source === 'email' && overrides.description === undefined) {
        const sp = p.source_payload || {}
        const fromName = sp.fromName || sp.from || 'expéditeur inconnu'
        const dateFr = formatDateFr(sp.receivedAt)
        description = dateFr ? `Mail de ${fromName} reçu le ${dateFr}` : `Mail de ${fromName}`
        const initialBody = sp.bodyText || extractBodyFromLegacyDescription(p.suggested_description)
        if (initialBody) {
          messagesToInsert.push({
            author: fromName,
            content: initialBody,
            createdAt: sp.receivedAt || null,
          })
        }
        for (const reply of (Array.isArray(sp.replies) ? sp.replies : [])) {
          const replyContent = reply.bodyText || reply.bodyPreview || ''
          if (!replyContent) continue
          messagesToInsert.push({
            author: reply.fromName || reply.from || fromName,
            content: replyContent,
            createdAt: reply.receivedAt || null,
          })
        }
      }

      const { rows: tRows } = await client.query(`
        INSERT INTO tickets
          (title, description, priority, device_id, user_id, source, is_auto,
           created_by_entra_id, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)
        RETURNING *
      `, [title, description || null, priority, device_id || null, user_id || null,
          p.source, entraId, displayName])
      const tk = tRows[0]

      // Phase 2 : peuple les tables M2M (idem que POST /tickets).
      if (tk.user_id)   await syncRequester(client, tk.id, tk.user_id)
      if (tk.device_id) await addDeviceToTicket(client, tk.id, tk.device_id)

      for (const m of messagesToInsert) {
        // created_at explicite quand on connaît la date du mail réelle, pour
        // que la timeline reflète la vraie chronologie du fil et pas l'ordre
        // d'INSERT. email_sent_at=now() : c'est un mail déjà reçu, l'outbox
        // doit l'ignorer.
        await client.query(`
          INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
          VALUES ($1, 'comment', $2, $3, now(), COALESCE($4::timestamptz, now()))
        `, [tk.id, m.author, m.content, m.createdAt])
      }

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

      // Repointe les email_thread_mapping qui pointaient sur cette proposal
      // vers le ticket créé. Sans ça :
      //   - has_inbound_mail reste false côté GET /tickets/:id → le bouton
      //     "Envoyer par mail" (Phase 1c) n'apparaît jamais
      //   - le worker outbound filtre `ticket_id IS NOT NULL` → l'envoi
      //     vers le requester est impossible
      // Concerne uniquement source='email' en pratique, mais on update
      // sans filtre source pour rester insensible aux futurs sources.
      await client.query(
        `UPDATE email_thread_mapping SET ticket_id = $1 WHERE proposal_id = $2`,
        [tk.id, p.id]
      )

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
