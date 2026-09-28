// Routes d'inspection du pont mail (Phase 1, issue #8).
//
// Phase 1 = lecture seulement, donc une seule route utile : voir ce qui a
// été ingéré pour vérifier que le polling fonctionne. Admin-only — les
// mails contiennent des données sensibles (expéditeurs, subjects).
//
// Les routes de configuration (mail.inboxes, mail.poll_enabled) passent
// par l'API existante /api/settings — pas besoin d'endpoints dédiés ici.

import { prepareThread, createTicketFromMapping, attachMappingToTicket, dismissInboxMapping, readMappingBody, findThreadSiblings } from '../lib/inbox.js'
import { htmlToText } from '../lib/body-text.js'
import { MAX_INGEST_ATTEMPTS } from '../lib/poll-cursor.js'

const BLOCKED_DISPLAY_MS = 5 * 60_000

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
      `SELECT key, value FROM settings WHERE key IN ('mail.inboxes', 'mail.poll_enabled', 'mail.sent_mailboxes')
         OR key LIKE 'mail.cursor%' OR key LIKE 'mail.sent\\_cursor%'`
    )
    const settings = Object.fromEntries(setRows.map(r => [r.key, r.value]))
    const csv = key => (settings[key] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const inboxes = csv('mail.inboxes')

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
      // Éléments envoyés (sent-poll-worker) : curseur et blocage seulement.
      sent_mailboxes: csv('mail.sent_mailboxes').map(m => ({
        address: m,
        cursor: settings[`mail.sent_cursor.${m}`] || null,
        blocked: blockedState(settings[`mail.sent_cursor.${m}`], settings[`mail.sent_cursor_state.${m}`]),
      })),
    })
  })

  // Mail en échec qui retient le curseur d'une boîte (cf. lib/poll-cursor.js),
  // lu dans son état JSON — ignoré s'il se rapporte à un autre curseur,
  // comme le fait le worker. Pas affiché pour un premier échec passager :
  // seulement après MAX_INGEST_ATTEMPTS tentatives ou BLOCKED_DISPLAY_MS.
  function blockedState(cursor, rawState) {
    try {
      const state = JSON.parse(rawState)
      const r = state?.retry
      if (!r || !cursor || state.at !== new Date(cursor).toISOString()) return null
      const age = Date.now() - Date.parse(r.first_at)
      if (!(r.attempts >= MAX_INGEST_ATTEMPTS || age >= BLOCKED_DISPLAY_MS)) return null
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
               etm.action, etm.classifier_result, etm.conversation_id,
               etm.raw->>'bodyPreview' AS body_preview,
               etm.raw->'from'->'emailAddress'->>'name' AS from_name,
               COALESCE((etm.raw->>'hasAttachments')::boolean, false) AS has_attachments,
               u.entra_id   AS suggested_user_id,
               u.display_name AS suggested_user_name,
               d.id         AS suggested_device_id,
               d.hostname   AS suggested_device_hostname,
               -- Taille du fil : autres mails ingérés de la même conversation
               -- Outlook, pas encore rattachés à un ticket (à trier ou mis de
               -- côté). Ils seront versés dans le ticket avec ce mail.
               th.n AS thread_count
        FROM email_thread_mapping etm
        -- match best-effort sur l'expéditeur pour suggérer un user/device
        -- côté UI (l'admin peut ré-attribuer manuellement après création).
        LEFT JOIN users_cache u ON LOWER(u.email) = LOWER(etm.from_address)
        LEFT JOIN devices d     ON d.assigned_user_id = u.entra_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n FROM email_thread_mapping s
          WHERE s.conversation_id = etm.conversation_id
            AND s.ticket_id IS NULL AND s.proposal_id IS NULL
            AND (s.action IN ('pending_review', 'skipped_other') OR s.action IS NULL)
        ) th ON etm.conversation_id IS NOT NULL
        ${where}
        ORDER BY etm.received_at DESC NULLS LAST, etm.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, params)

      // Strip HTML défensif sur body_preview à la lecture. Les mails ingérés
      // pré-Phase-3 stockaient parfois du bodyPreview Outlook avec balises
      // résiduelles dans raw. On normalise ici sans toucher à raw lui-même
      // (qui reste la source brute Graph pour le diagnostic admin).
      for (const r of rows) {
        r.body_preview = htmlToText(r.body_preview || '')
        r.thread_count = r.thread_count || 1
      }

      reply.send(rows)
    })

  // GET /api/email/inbox/:id/thread — les mails ingérés du même fil (celui
  // demandé compris), dans l'ordre chronologique : ce que « → Ticket »
  // versera dans le ticket. Les mails plus anciens encore dans la boîte
  // mais jamais ingérés ne sont pas listés ici (récupérés à la création).
  // Ids venus de l'URL : un non-UUID est un « introuvable », pas une erreur
  // Postgres 22P02 à démêler après coup.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isUuid = (v) => UUID_RE.test(String(v || ''))
  const notFoundMail = (reply) => reply.code(404).send({ error: 'Mail introuvable' })

  // Phase 1 du tri (appels Graph, hors transaction : aucun verrou tenu).
  // Répond 404/409 et retourne null si le mail n'est pas rattachable.
  async function prepareInboxThread(req, reply) {
    if (!isUuid(req.params.id)) { notFoundMail(reply); return null }
    try {
      return await prepareThread(fastify.db, fastify.log, req.params.id)
    } catch (err) {
      if (err.message === 'MAPPING_NOT_FOUND') { notFoundMail(reply); return null }
      if (err.message === 'ALREADY_LINKED') { reply.code(409).send({ error: 'Mail déjà lié à un ticket' }); return null }
      throw err
    }
  }
  // Deux admins sur le même fil en même temps : Postgres tranche (deadlock
  // détecté ou verrou refusé) → 409, le second re-clic verra l'état à jour.
  const isLockConflict = (err) => err.code === '40P01' || err.code === '55P03'

  fastify.get('/inbox/:id/thread',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      if (!isUuid(req.params.id)) return notFoundMail(reply)
      const { rows } = await fastify.db.query(
        `SELECT id, mailbox, internet_message_id, conversation_id, direction, from_address,
                subject, received_at, raw, action, ticket_id
         FROM email_thread_mapping WHERE id = $1`, [req.params.id]
      )
      if (!rows.length) return notFoundMail(reply)
      const m = rows[0]
      const siblings = m.ticket_id ? [] : await findThreadSiblings(fastify.db, m)
      const items = [m, ...siblings]
        .map(r => ({
          id: r.id,
          direction: r.direction,
          from_address: r.from_address,
          from_name: r.raw?.from?.emailAddress?.name || null,
          subject: r.subject,
          received_at: r.received_at,
          action: r.action,
          has_attachments: !!r.raw?.hasAttachments,
          body_preview: htmlToText(r.raw?.bodyPreview || ''),
        }))
        .sort((a, b) => Date.parse(a.received_at || 0) - Date.parse(b.received_at || 0))
      reply.send(items)
    })

  // GET /api/email/inbox/:id/body — corps complet du mail (Graph, sinon
  // aperçu). Lecture à la demande : un mail se lit avant d'être trié.
  fastify.get('/inbox/:id/body',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      if (!isUuid(req.params.id)) return notFoundMail(reply)
      try {
        reply.send(await readMappingBody(fastify.db, fastify.log, req.params.id))
      } catch (err) {
        if (err.message === 'MAPPING_NOT_FOUND') return notFoundMail(reply)
        throw err
      }
    })

  // GET /api/email/inbox/count — compteur pour le badge UI.
  fastify.get('/inbox/count',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      // pending = mails ; threads = fils (regroupés par conversation, comme
      // la liste « À trier ») — c'est ce que les badges affichent.
      const { rows } = await fastify.db.query(
        `SELECT COUNT(*)::int AS pending,
                COUNT(DISTINCT COALESCE(conversation_id, id::text))::int AS threads
         FROM email_thread_mapping
         WHERE direction = 'inbound' AND action = 'pending_review'`
      )
      reply.send({ pending: rows[0].pending, threads: rows[0].threads })
    })

  // POST /api/email/inbox/:id/to-ticket
  // Convertit un mail en attente en ticket. Crée le ticket avec sa première
  // description, peuple le premier ticket_message, sync les M2M, et repointe
  // le mapping. Idempotent : si déjà lié à un ticket → 409.
  fastify.post('/inbox/:id/to-ticket',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const { entraId, displayName } = fastify.getUserIdentity(req)
      const prepared = await prepareInboxThread(req, reply)
      if (!prepared) return reply
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        const tk = await createTicketFromMapping(client, fastify.log, {
          mappingId: req.params.id,
          byEntraId: entraId,
          byName:    displayName,
          prepared,
        })
        await client.query('COMMIT')
        reply.code(201).send({ ticket: tk, absorbed: tk.absorbed_count })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'MAPPING_NOT_FOUND') return notFoundMail(reply)
        if (err.message === 'ALREADY_LINKED')    return reply.code(409).send({ error: 'Mail déjà lié à un ticket' })
        if (isLockConflict(err))                 return reply.code(409).send({ error: 'Fil en cours de traitement, réessayez' })
        throw err
      } finally {
        client.release()
      }
    })

  // POST /api/email/inbox/:id/attach { ticket_id }
  // Rattache un mail en attente (et son fil) à un ticket existant : le mail
  // était la suite d'une demande déjà ouverte, sans en-têtes de threading
  // exploitables (nouveau mail « au lieu de répondre »). Un ticket résolu
  // ou archivé est rouvert.
  fastify.post('/inbox/:id/attach',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const ticketId = String(req.body?.ticket_id || '').trim()
      if (!ticketId) return reply.code(400).send({ error: 'ticket_id requis' })
      if (!isUuid(ticketId)) return reply.code(404).send({ error: 'Ticket introuvable' })
      const prepared = await prepareInboxThread(req, reply)
      if (!prepared) return reply
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        const out = await attachMappingToTicket(client, fastify.log, {
          mappingId: req.params.id, ticketId, prepared,
        })
        await client.query('COMMIT')
        reply.send(out)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'MAPPING_NOT_FOUND') return notFoundMail(reply)
        if (err.message === 'ALREADY_LINKED')    return reply.code(409).send({ error: 'Mail déjà lié à un ticket' })
        if (err.message === 'TICKET_NOT_FOUND')  return reply.code(404).send({ error: 'Ticket introuvable' })
        if (err.message === 'TICKET_MERGED')     return reply.code(409).send({ error: 'Ticket fusionné — choisir le ticket final' })
        if (isLockConflict(err))                 return reply.code(409).send({ error: 'Fil en cours de traitement, réessayez' })
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
      if (!isUuid(req.params.id)) return notFoundMail(reply)
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        await dismissInboxMapping(client, req.params.id, { wholeThread: req.body?.whole_thread === true })
        await client.query('COMMIT')
        reply.send({ ok: true })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'MAPPING_NOT_FOUND') return notFoundMail(reply)
        if (err.message === 'NOT_PENDING')       return reply.code(409).send({ error: 'Mail déjà traité' })
        if (isLockConflict(err))                 return reply.code(409).send({ error: 'Fil en cours de traitement, réessayez' })
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
