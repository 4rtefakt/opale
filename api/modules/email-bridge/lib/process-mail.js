// Pipeline de traitement d'un mail entrant (issue #8 + refonte Phase 3).
//
// Pour chaque mail Graph reçu :
//   1. Pré-check : déjà dans email_thread_mapping ? (idempotence)
//   2. Match thread : ce mail répond-il à un ticket / proposal existant ?
//   3. Classify (Ollama) en MODE ADVISORY : l'intent sert juste de
//      suggestion visuelle côté UI, il ne décide plus de l'action.
//   4. Décide l'action :
//        - thread match (ticket existant)        → append message au ticket
//        - thread match (proposal pending, 1b)   → append à source_payload.replies
//        - aucun match                           → action='pending_review'
//          (l'admin traite via la vue "Mails à trier", routes
//          /api/email/inbox/:id/to-ticket et /dismiss)
//   5. Exécute l'action en transaction unique.
//
// La transaction couvre INSERT mapping + action. Le curseur côté worker
// n'est avancé qu'APRÈS retour de processOne — un crash mid-page laisse
// les mails non-traités dans la fenêtre du prochain poll.

import { matchSender }   from './match-sender.js'
import { matchThread }   from './match-thread.js'
import { classifyWithOllama } from './classify.js'
import { getMessage }    from './graph-mail.js'
import { extractMailBodyText, htmlToText } from './body-text.js'

// Microsoft Graph dit que `bodyPreview` est plain text, mais en pratique
// quelques mails Outlook (forwards inline, contenus mixtes) ont du HTML
// résiduel. On strippe systématiquement quand on touche bodyPreview, en
// défense en profondeur : si extractMailBodyText échoue ou si le mail est
// "other" (intent qui skip getMessage), on ne fuit pas du HTML brut en DB.
function safeBodyPreview(graphMessage) {
  const raw = graphMessage?.bodyPreview || ''
  return htmlToText(raw).slice(0, 1000)
}

// Extrait les headers RFC du payload Graph. `internetMessageHeaders` est une
// liste [{name, value}], on construit un index lowercased.
function indexHeaders(graphMessage) {
  const idx = {}
  for (const h of graphMessage?.internetMessageHeaders || []) {
    if (h?.name) idx[h.name.toLowerCase()] = h.value || ''
  }
  return idx
}

// Lit les settings du classifieur en un seul aller-retour.
async function getClassifierConfig(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN (
       'mail.classifier.url',
       'mail.classifier.model',
       'mail.classifier.enabled',
       'mail.classifier.fallback_intent'
     )`
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    enabled:        map['mail.classifier.enabled'] === 'true',
    url:            map['mail.classifier.url']     || '',
    model:          map['mail.classifier.model']   || '',
    fallbackIntent: map['mail.classifier.fallback_intent'] || 'new_ticket',
  }
}

// Wrapper classifieur avec gestion d'erreur : retourne TOUJOURS un objet
// {intent, confidence, reason, fallback?}. Si désactivé / KO, applique le
// fallback ET marque `fallback: true` dans la sortie.
//
// IMPORTANT : `confidence: 0` sur un fallback ≠ "modèle dit 0%". Le front
// (cf. proposalCard) doit différencier les deux pour ne pas afficher un
// faux "0%" sur les propositions issues d'une erreur de classification.
async function classifySafe(db, log, message, { classifierFn } = {}) {
  const cfg = await getClassifierConfig(db)
  const fallback = {
    intent: cfg.fallbackIntent === 'other' ? 'other' :
            cfg.fallbackIntent === 'reply' ? 'reply' : 'new_ticket',
    confidence: 0,
    reason: 'classifier disabled — fallback',
    fallback: true,
  }
  if (!cfg.enabled || !cfg.url || !cfg.model) return fallback

  try {
    const fn = classifierFn || classifyWithOllama
    // Vraie classif : pas de flag fallback (= undefined → falsy côté front).
    return await fn(message, { url: cfg.url, model: cfg.model })
  } catch (err) {
    log?.warn({ err: err.message }, 'email-bridge: classifieur a échoué, fallback')
    return { ...fallback, reason: `classifier error: ${err.message}` }
  }
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function appendMessageToTicket(client, { ticketId, authorName, content }) {
  // email_sent_at = now() : ce message vient déjà d'un mail. L'outbox doit
  // l'ignorer, sinon on renverrait le mail à son propre expéditeur (loop).
  await client.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
    VALUES ($1, 'comment', $2, $3, now())
  `, [ticketId, authorName, content])
  await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticketId])
}

// Phase 1b : un mail répond à une proposal pending (pas encore acceptée).
// On veut accumuler les relances dans la MÊME proposal au lieu d'en créer
// des nouvelles. Stockage : source_payload.replies[] (array, ordre d'arrivée).
// SELECT FOR UPDATE pour sérialiser les inserts concurrents (2 mails en
// parallèle sur la même proposal).
async function appendReplyToProposal(client, { proposalId, graphMessage, sender, bodyText }) {
  const { rows } = await client.query(
    `SELECT source_payload FROM ticket_proposals WHERE id = $1 FOR UPDATE`,
    [proposalId]
  )
  if (!rows.length) return false
  const payload = rows[0].source_payload || {}
  const replies = Array.isArray(payload.replies) ? payload.replies : []
  replies.push({
    internetMessageId: graphMessage.internetMessageId || null,
    from:              graphMessage.from?.emailAddress?.address || null,
    fromName:          graphMessage.from?.emailAddress?.name || sender.user_name || null,
    subject:           graphMessage.subject || null,
    receivedAt:        graphMessage.receivedDateTime || null,
    bodyText:          bodyText || null,
    bodyPreview:       safeBodyPreview(graphMessage),
  })
  payload.replies = replies
  await client.query(
    `UPDATE ticket_proposals SET source_payload = $1 WHERE id = $2`,
    [JSON.stringify(payload), proposalId]
  )
  return true
}

// ── Pipeline principal ────────────────────────────────────────────────────────

// Process un seul mail Graph dans une transaction. Idempotent : si déjà en
// mapping, retourne immédiatement {skipped: 'already-ingested'} sans rien
// modifier.
//
// Retour : {action, ticket_id?, proposal_id?, intent?, error?}
//   action : 'message_appended' | 'reply_appended_to_proposal' |
//            'pending_review' | 'already_ingested' | 'skipped_error'
export async function processOne(db, log, { graphMessage, mailbox, classifierFn }) {
  const internetMessageId = graphMessage.internetMessageId
  if (!internetMessageId) {
    log?.warn({ mailbox, graphId: graphMessage.id }, 'process: mail sans internetMessageId, skip')
    return { action: 'skipped_error', error: 'no internetMessageId' }
  }

  // Pré-check rapide hors tx — si déjà ingéré, on évite tout le travail.
  // Race-condition acceptable : un double-process sera bloqué par l'UNIQUE
  // sur internet_message_id (ON CONFLICT DO NOTHING dans l'INSERT mapping).
  {
    const { rows } = await db.query(
      `SELECT id FROM email_thread_mapping WHERE internet_message_id = $1`,
      [internetMessageId]
    )
    if (rows.length) return { action: 'already_ingested' }
  }

  // Phase travail "hors tx" : match thread + classify (potentiellement lent).
  // Aucune écriture DB ici.
  const headers = indexHeaders(graphMessage)
  const fromAddress = graphMessage.from?.emailAddress?.address || null

  const [sender, threadMatch] = await Promise.all([
    matchSender(db, fromAddress),
    matchThread(db, {
      inReplyToHeader:  headers['in-reply-to']  || null,
      referencesHeader: headers['references']   || null,
      conversationId:   graphMessage.conversationId || null,
      subject:          graphMessage.subject    || null,
    }),
  ])

  let classifier = null
  let intent     = null

  if (threadMatch?.ticket_id) {
    // Thread connu sur un ticket existant : on saute le classifieur.
    intent = 'reply'
    classifier = { intent: 'reply', confidence: 1, reason: 'thread match (existing ticket)' }
  } else if (threadMatch?.proposal_id) {
    intent = 'reply'
    classifier = { intent: 'reply', confidence: 1, reason: 'thread match (pending proposal)' }
  } else {
    classifier = await classifySafe(db, log, {
      from: fromAddress, subject: graphMessage.subject, bodyPreview: safeBodyPreview(graphMessage),
    }, { classifierFn })
    intent = classifier.intent
  }

  // On ne récupère le body complet via getMessage() QUE si on va l'utiliser
  // immédiatement pour append à un ticket ou une proposal existants. Pour
  // les mails en pending_review (Phase 3), on diffère l'appel jusqu'à ce
  // que l'admin clique "→ Ticket" — ça économise un appel Graph par mail
  // (volume newsletters / notifications qui finiront en dismiss).
  let bodyText = null
  if (threadMatch?.ticket_id || threadMatch?.proposal_id) {
    try {
      const full = await getMessage(mailbox, graphMessage.id)
      bodyText = extractMailBodyText(graphMessage, full)
    } catch (err) {
      log?.warn({ err: err.message, internetMessageId },
        'process: full body fetch failed, fallback sur bodyPreview')
    }
  }

  // ── Transaction : mapping + action ──────────────────────────────────────────
  // Stratégie : INSERT mapping en PREMIER avec ON CONFLICT DO NOTHING. Si
  // rowCount=0, un autre tick a gagné la course → ROLLBACK + skip. Sinon on
  // tient la dedup-lock (clé UNIQUE) pour le reste de la tx, et on peut
  // créer proposition / message sans crainte de doublon.
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const insertMapping = await client.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, conversation_id, graph_message_id,
         mailbox, direction, from_address, subject, received_at, raw,
         processed_at, classifier_result)
      VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, $8, now(), $9)
      ON CONFLICT (internet_message_id) DO NOTHING
      RETURNING id
    `, [
      internetMessageId,
      graphMessage.conversationId || null,
      graphMessage.id || null,
      mailbox,
      fromAddress,
      graphMessage.subject || null,
      graphMessage.receivedDateTime || null,
      JSON.stringify(graphMessage),
      JSON.stringify(classifier),
    ])
    if (insertMapping.rowCount === 0) {
      await client.query('ROLLBACK')
      return { action: 'already_ingested' }
    }
    const mappingId = insertMapping.rows[0].id

    let action       = null
    let ticketId     = threadMatch?.ticket_id    || null
    let proposalId   = threadMatch?.proposal_id  || null
    let errorMessage = null

    if (threadMatch?.ticket_id) {
      const authorName = sender.user_name || fromAddress || 'Email'
      const content = bodyText || safeBodyPreview(graphMessage) || '(corps vide)'
      await appendMessageToTicket(client, {
        ticketId: threadMatch.ticket_id, authorName, content,
      })
      action = 'message_appended'
    } else if (threadMatch?.proposal_id) {
      // Phase 1b — réponse à une proposition pas encore acceptée.
      // On accumule dans source_payload.replies[] au lieu de créer une
      // nouvelle proposal (sinon le maintainer voit N propositions doublons
      // pour le même thread, et perd le contexte des relances).
      // À l'acceptation de la proposal, les replies seront convertis en
      // ticket_message individuels chronologiquement.
      const appended = await appendReplyToProposal(client, {
        proposalId: threadMatch.proposal_id, graphMessage, sender, bodyText,
      })
      action = appended ? 'reply_appended_to_proposal' : 'skipped_error'
      if (!appended) errorMessage = `proposal ${threadMatch.proposal_id} introuvable au moment de l'append`
    } else {
      // Phase 3 — Plus de classification automatique en proposal vs other.
      // Tout mail sans thread match arrive en 'pending_review' : l'admin
      // décide via la vue "Mails à trier" si c'est un ticket (route
      // /to-ticket) ou à ignorer (route /dismiss). Le classifier reste
      // appelé en mode advisory : son intent et sa confidence sont stockés
      // dans classifier_result (déjà fait au INSERT mapping ci-dessus) et
      // servent juste de suggestion visuelle côté front.
      action = 'pending_review'
    }

    await client.query(`
      UPDATE email_thread_mapping
      SET ticket_id = $1, proposal_id = $2, action = $3, error_message = $4
      WHERE id = $5
    `, [ticketId, proposalId, action, errorMessage, mappingId])

    await client.query('COMMIT')
    return { action, ticket_id: ticketId, proposal_id: proposalId, intent, error: errorMessage }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log?.warn({ err: err.message, mailbox, internetMessageId }, 'email-bridge: tx process échouée')
    return { action: 'skipped_error', error: err.message }
  } finally {
    client.release()
  }
}
