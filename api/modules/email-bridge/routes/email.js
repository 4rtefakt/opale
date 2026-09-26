// Routes d'inspection du pont mail (Phase 1, issue #8).
//
// Phase 1 = lecture seulement, donc une seule route utile : voir ce qui a
// été ingéré pour vérifier que le polling fonctionne. Admin-only — les
// mails contiennent des données sensibles (expéditeurs, subjects).
//
// Les routes de configuration (mail.inboxes, mail.poll_enabled) passent
// par l'API existante /api/settings — pas besoin d'endpoints dédiés ici.

import { createTicketFromMapping, dismissInboxMapping } from '../lib/inbox.js'
import { htmlToText } from '../lib/body-text.js'

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
             from_address, subject, received_at, ticket_id, proposal_id,
             action, classifier_result, error_message, created_at
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
      `SELECT key, value FROM settings WHERE key IN ('mail.inboxes', 'mail.poll_enabled')
         OR key LIKE 'mail.cursor.%' OR key LIKE 'mail.cursor\\_state.%'`
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
        blocked: blockedState(settings[`mail.cursor.${m}`], settings[`mail.cursor_state.${m}`]),
      })),
    })
  })

  // Mail en échec qui retient le curseur d'une boîte (cf. lib/poll-cursor.js),
  // lu dans son état JSON — ignoré s'il se rapporte à un autre curseur,
  // comme le fait le worker.
  function blockedState(cursor, rawState) {
    try {
      const state = JSON.parse(rawState)
      const r = state?.retry
      if (!r || !cursor || state.at !== new Date(cursor).toISOString()) return null
      return { since: r.first_at ?? null, attempts: r.attempts, error: r.error ?? null, internet_message_id: r.internet_message_id ?? null }
    } catch {
      return null
    }
  }

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
      // Phase 3 : nouveau pipeline → 'pending_review' remplace les
      // proposal_created automatiques. Les anciennes valeurs restent
      // dans le breakdown pour ne pas casser les graphes legacy qui
      // pointent encore sur des mappings pré-Phase-3 dans la fenêtre.
      pending_review:               0,
      reply_appended_to_proposal:   0,  // Phase 1b
      proposal_created:             0,  // pré-Phase-3
      proposal_created_no_match:    0,  // pré-Phase-3
      message_appended:             0,
      skipped_other:                0,
      skipped_error:                0,
      in_queue:                     0,  // action IS NULL → encore dans le pipeline
    }
    let total = 0
    for (const r of rows) {
      total += r.n
      if (r.action === null) byAction.in_queue = r.n
      else if (byAction[r.action] !== undefined) byAction[r.action] = r.n
    }
    reply.send({ since, days, total, by_action: byAction })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3 — Vue "Mails à trier" (inbox)
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/email/inbox?limit=&offset=&status=pending_review
  // Liste les mails ingérés en attente d'arbitrage humain. status par défaut
  // = 'pending_review'. Peut prendre 'all' pour tout voir (admin debug).
  fastify.get('/inbox',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const limit  = Math.min(parseInt(req.query.limit  ?? 100, 10) || 100, 500)
      const offset = Math.max(parseInt(req.query.offset ?? 0,   10) || 0,    0)
      const status = req.query.status || 'pending_review'

      const conds  = [`direction = 'inbound'`]
      const params = []
      let i = 1
      if (status === 'pending_review') {
        conds.push(`action = $${i++}`); params.push('pending_review')
      } else if (status !== 'all') {
        conds.push(`action = $${i++}`); params.push(status)
      }
      const where = 'WHERE ' + conds.join(' AND ')
      params.push(limit, offset)

      const { rows } = await fastify.db.query(`
        SELECT etm.id, etm.mailbox, etm.from_address, etm.subject, etm.received_at,
               etm.action, etm.classifier_result,
               etm.raw->>'bodyPreview' AS body_preview,
               u.entra_id   AS suggested_user_id,
               u.display_name AS suggested_user_name,
               d.id         AS suggested_device_id,
               d.hostname   AS suggested_device_hostname
        FROM email_thread_mapping etm
        -- match best-effort sur l'expéditeur pour suggérer un user/device
        -- côté UI (l'admin peut ré-attribuer manuellement après création).
        LEFT JOIN users_cache u ON LOWER(u.email) = LOWER(etm.from_address)
        LEFT JOIN devices d     ON d.assigned_user_id = u.entra_id
        ${where}
        ORDER BY etm.received_at DESC NULLS LAST, etm.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, params)

      // Strip HTML défensif sur body_preview à la lecture. Les mails ingérés
      // pré-Phase-3 stockaient parfois du bodyPreview Outlook avec balises
      // résiduelles dans raw. On normalise ici sans toucher à raw lui-même
      // (qui reste la source brute Graph pour le diagnostic admin).
      for (const r of rows) r.body_preview = htmlToText(r.body_preview || '')

      reply.send(rows)
    })

  // GET /api/email/inbox/count — compteur pour le badge UI.
  fastify.get('/inbox/count',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const { rows } = await fastify.db.query(
        `SELECT COUNT(*)::int AS pending FROM email_thread_mapping
         WHERE direction = 'inbound' AND action = 'pending_review'`
      )
      reply.send({ pending: rows[0].pending })
    })

  // POST /api/email/inbox/:id/to-ticket
  // Convertit un mail en attente en ticket. Crée le ticket avec sa première
  // description, peuple le premier ticket_message, sync les M2M, et repointe
  // le mapping. Idempotent : si déjà lié à un ticket → 409.
  fastify.post('/inbox/:id/to-ticket',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const { entraId, displayName } = fastify.getUserIdentity(req)
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        const tk = await createTicketFromMapping(client, fastify.log, {
          mappingId: req.params.id,
          byEntraId: entraId,
          byName:    displayName,
        })
        await client.query('COMMIT')
        reply.code(201).send({ ticket: tk })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'MAPPING_NOT_FOUND') return reply.code(404).send({ error: 'Mail introuvable' })
        if (err.message === 'ALREADY_LINKED')    return reply.code(409).send({ error: 'Mail déjà lié à un ticket' })
        throw err
      } finally {
        client.release()
      }
    })

  // POST /api/email/inbox/:id/dismiss
  // Marque le mail comme ignoré (action='skipped_other') sans créer de
  // ticket. Idempotent : re-clic = 200 no-op.
  fastify.post('/inbox/:id/dismiss',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        await dismissInboxMapping(client, req.params.id)
        await client.query('COMMIT')
        reply.send({ ok: true })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'MAPPING_NOT_FOUND') return reply.code(404).send({ error: 'Mail introuvable' })
        if (err.message === 'NOT_PENDING')       return reply.code(409).send({ error: 'Mail déjà traité' })
        throw err
      } finally {
        client.release()
      }
    })

  // GET /api/email/diagnostic — vue d'ensemble pour la modale debug :
  // config classifieur + dernières erreurs + comptage par mailbox.
  // Permet à l'admin de comprendre "pourquoi le compteur est bas" sans
  // ouvrir un terminal psql.
  fastify.get('/diagnostic', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    // Settings du pont (sans le secret OAuth, qu'on a pas ici de toute façon).
    const { rows: setRows } = await fastify.db.query(
      `SELECT key, value FROM settings WHERE key LIKE 'mail.%'`
    )
    const settings = Object.fromEntries(setRows.map(r => [r.key, r.value]))

    // Dernières erreurs : mails dont la classif a fallback ou skip_error.
    // On retourne juste les 10 plus récents pour un coup d'œil rapide.
    const { rows: errors } = await fastify.db.query(`
      SELECT id, mailbox, from_address, subject, received_at, action,
             classifier_result, error_message
      FROM email_thread_mapping
      WHERE action = 'skipped_error'
         OR (classifier_result->>'fallback')::boolean = true
      ORDER BY processed_at DESC NULLS LAST, created_at DESC
      LIMIT 10
    `)

    reply.send({
      // Note : on n'expose volontairement PAS la liste complète des paires
      // clé/valeur ; on filtre les clés non sensibles (URLs, noms, flags).
      // Pas de secret côté Mail (l'auth Graph passe par ENTRA_CLIENT_SECRET
      // chargé en env, jamais en DB).
      config: {
        inboxes:           settings['mail.inboxes']        || '',
        poll_enabled:      settings['mail.poll_enabled']   === 'true',
        send_enabled:      settings['mail.send_enabled']   === 'true',
        sender_address:    settings['mail.sender_address'] || '',
        mark_as_read_enabled: settings['mail.mark_as_read_enabled'] === 'true',
        classifier: {
          enabled:         settings['mail.classifier.enabled'] === 'true',
          url:             settings['mail.classifier.url']     || '',
          model:           settings['mail.classifier.model']   || '',
          fallback_intent: settings['mail.classifier.fallback_intent'] || 'new_ticket',
        },
      },
      recent_errors: errors,
    })
  })
}
