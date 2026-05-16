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
}
