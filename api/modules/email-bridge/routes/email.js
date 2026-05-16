// Routes d'inspection du pont mail (Phase 1, issue #8).
//
// Phase 1 = lecture seulement, donc une seule route utile : voir ce qui a
// été ingéré pour vérifier que le polling fonctionne. Admin-only — les
// mails contiennent des données sensibles (expéditeurs, subjects).
//
// Les routes de configuration (mail.inboxes, mail.poll_enabled) passent
// par l'API existante /api/settings — pas besoin d'endpoints dédiés ici.

export default async function emailRoute(fastify) {

  // GET /api/email/recent?mailbox=&limit=50
  // Liste les mails ingérés, plus récents en tête. Filtre optionnel par
  // mailbox. Pas de pagination offset : Phase 1 = debug, 200 max suffit.
  fastify.get('/recent', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? 50, 10) || 50, 200)
    const mailbox = req.query.mailbox ? String(req.query.mailbox).trim().toLowerCase() : null

    const conds = []
    const params = []
    let i = 1
    if (mailbox) { conds.push(`mailbox = $${i++}`); params.push(mailbox) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    params.push(limit)

    const { rows } = await fastify.db.query(`
      SELECT id, internet_message_id, conversation_id, mailbox, direction,
             from_address, subject, received_at, ticket_id, created_at
      FROM email_thread_mapping
      ${where}
      ORDER BY received_at DESC NULLS LAST, created_at DESC
      LIMIT $${i}
    `, params)
    reply.send(rows)
  })

  // GET /api/email/status — vue d'ensemble pour vérifier la conf au boot.
  // Liste les mailboxes configurées + leur curseur courant + compteur ingérés.
  fastify.get('/status', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: setRows } = await fastify.db.query(
      `SELECT key, value FROM settings WHERE key IN ('mail.inboxes', 'mail.poll_enabled') OR key LIKE 'mail.cursor.%'`
    )
    const settings = Object.fromEntries(setRows.map(r => [r.key, r.value]))
    const inboxes = (settings['mail.inboxes'] || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

    const { rows: countRows } = await fastify.db.query(`
      SELECT mailbox, COUNT(*)::int AS total, MAX(received_at) AS last_received_at
      FROM email_thread_mapping
      GROUP BY mailbox
    `)
    const byMailbox = new Map(countRows.map(r => [r.mailbox, r]))

    reply.send({
      poll_enabled: settings['mail.poll_enabled'] === 'true',
      mailboxes: inboxes.map(m => ({
        address: m,
        cursor: settings[`mail.cursor.${m}`] || null,
        total_ingested: byMailbox.get(m)?.total || 0,
        last_received_at: byMailbox.get(m)?.last_received_at || null,
      })),
    })
  })

  // GET /api/email/stats?days=7 — breakdown des actions du pipeline sur la
  // fenêtre donnée. Utilisé par le bandeau "cette semaine" en haut de la
  // vue Tickets (cf. front/views/tickets.js).
  //
  // Réponse :
  //   { since, total, by_action: { proposal_created, proposal_created_no_match,
  //                                message_appended, skipped_other, skipped_error,
  //                                in_queue } }
  // - `in_queue` : mails ingérés (mapping créé) mais sans action terminale
  //   posée (transitoire — souvent 0). Réelement "en cours de traitement".
  fastify.get('/stats', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const days = Math.min(Math.max(parseInt(req.query.days ?? 7, 10) || 7, 1), 90)
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

    const { rows } = await fastify.db.query(`
      SELECT action, COUNT(*)::int AS n
      FROM email_thread_mapping
      WHERE created_at >= $1
      GROUP BY action
    `, [since])

    const byAction = {
      proposal_created: 0,
      proposal_created_no_match: 0,
      message_appended: 0,
      skipped_other: 0,
      skipped_error: 0,
      in_queue: 0,           // action IS NULL → encore dans le pipeline
    }
    let total = 0
    for (const r of rows) {
      total += r.n
      if (r.action === null) byAction.in_queue = r.n
      else if (byAction[r.action] !== undefined) byAction[r.action] = r.n
    }
    reply.send({ since, days, total, by_action: byAction })
  })
}
