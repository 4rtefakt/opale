// Pipeline de traitement d'un mail entrant (Phase 2/3, issue #8).
//
// Pour chaque mail Graph reçu :
//   1. Pré-check : déjà dans email_thread_mapping ? (idempotence)
//   2. Match thread : ce mail répond-il à un ticket/proposal existant ?
//   3. Sinon, classify (Ollama) → intent
//   4. Décide l'action :
//        - thread match (ticket existant) → append message au ticket
//        - thread match (proposition pas encore acceptée) → mémoriser le
//          mail en mapping avec proposal_id, mais pas d'action UI immédiate
//          (le mail sera attaché à la proposition à l'acceptation)
//        - intent='new_ticket' OU intent='reply' sans match → créer proposal
//        - intent='other' → skip (mapping row seule, traçabilité)
//   5. Exécute l'action en transaction unique.
//
// La transaction couvre INSERT mapping + INSERT proposal/message — si
// l'une plante, l'autre est rollback. Le curseur côté worker n'est avancé
// qu'APRÈS retour de processOne, pour qu'un crash mid-page laisse les
// mails non-traités dans la fenêtre du prochain poll.

import { matchSender }   from './match-sender.js'
import { matchThread }   from './match-thread.js'
import { classifyWithOllama } from './classify.js'

// Extrait les headers RFC du payload Graph. `internetMessageHeaders` est une
// liste [{name, value}], on construit un index lowercased.
function indexHeaders(graphMessage) {
  const idx = {}
  for (const h of graphMessage?.internetMessageHeaders || []) {
    if (h?.name) idx[h.name.toLowerCase()] = h.value || ''
  }
  return idx
}

// Méta minimales des PJ : nom, type, taille. Pas de téléchargement Phase 3.
function extractAttachmentMeta(graphMessage) {
  if (!graphMessage?.hasAttachments) return []
  // Graph nécessite un re-fetch /attachments pour avoir la liste détaillée.
  // En attendant, on signale juste qu'il y a des PJ.
  // (Phase 3.5 / 4 : si on veut les métadonnées détaillées, ajouter un
  // appel `listAttachments` ici. Volontaire de garder léger Phase 3.)
  return [{ note: 'attachments present, fetch on demand' }]
}

// Construit le source_payload stocké sur ticket_proposals.
function buildSourcePayload(graphMessage, mailbox) {
  return {
    mailbox,
    internetMessageId: graphMessage.internetMessageId || null,
    conversationId:    graphMessage.conversationId    || null,
    graphMessageId:    graphMessage.id                || null,
    from:              graphMessage.from?.emailAddress?.address || null,
    fromName:          graphMessage.from?.emailAddress?.name    || null,
    subject:           graphMessage.subject     || null,
    receivedAt:        graphMessage.receivedDateTime || null,
    bodyPreview:       (graphMessage.bodyPreview || '').slice(0, 1000),
    attachments:       extractAttachmentMeta(graphMessage),
  }
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
// {intent, confidence, reason}. Si désactivé / KO, applique le fallback.
async function classifySafe(db, log, message, { classifierFn } = {}) {
  const cfg = await getClassifierConfig(db)
  const fallback = {
    intent: cfg.fallbackIntent === 'other' ? 'other' :
            cfg.fallbackIntent === 'reply' ? 'reply' : 'new_ticket',
    confidence: 0,
    reason: 'classifier disabled — fallback',
  }
  if (!cfg.enabled || !cfg.url || !cfg.model) return fallback

  try {
    const fn = classifierFn || classifyWithOllama
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

async function createProposal(client, {
  graphMessage, mailbox, sender, intent, classifier,
}) {
  // Titre suggéré : le subject nettoyé des préfixes (Re:, TR:, Fwd:).
  const cleanSubject = (graphMessage.subject || '(sans sujet)')
    .replace(/^\s*(re|tr|fwd|fw)\s*:\s*/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')  // tag externe éventuel
    .trim() || '(sans sujet)'

  const description = [
    `De: ${sender.user_name || graphMessage.from?.emailAddress?.name || ''} <${graphMessage.from?.emailAddress?.address || ''}>`,
    `Sujet: ${graphMessage.subject || ''}`,
    '',
    graphMessage.bodyPreview || '(aperçu vide)',
  ].join('\n').slice(0, 4000)

  const { rows } = await client.query(`
    INSERT INTO ticket_proposals
      (source, source_ref_type, source_ref_id, source_payload,
       suggested_title, suggested_description, suggested_priority,
       suggested_device_id, suggested_user_id)
    VALUES ('email', 'email', NULL, $1, $2, $3, 'normal', $4, $5)
    RETURNING id
  `, [
    JSON.stringify({
      ...buildSourcePayload(graphMessage, mailbox),
      classifier: { intent, ...classifier },
    }),
    cleanSubject.slice(0, 200),
    description,
    sender.device_id || null,
    sender.user_id   || null,
  ])
  return rows[0].id
}

// ── Pipeline principal ────────────────────────────────────────────────────────

// Process un seul mail Graph dans une transaction. Idempotent : si déjà en
// mapping, retourne immédiatement {skipped: 'already-ingested'} sans rien
// modifier.
//
// Retour : {action, ticket_id?, proposal_id?, intent?, error?}
//   action : 'message_appended' | 'proposal_created' | 'skipped_other'
//          | 'pending_proposal' | 'already_ingested' | 'skipped_error'
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
      from: fromAddress, subject: graphMessage.subject, bodyPreview: graphMessage.bodyPreview,
    }, { classifierFn })
    intent = classifier.intent
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
      const content = graphMessage.bodyPreview || '(corps vide)'
      await appendMessageToTicket(client, {
        ticketId: threadMatch.ticket_id, authorName, content,
      })
      action = 'message_appended'
    } else if (intent === 'other') {
      // Non-ticket : mapping row seule, pour pouvoir ré-évaluer si la
      // classif s'est trompée (Phase 5 "ce n'est pas un ticket / si").
      action = 'skipped_other'
    } else if (intent === 'new_ticket' || intent === 'reply') {
      proposalId = await createProposal(client, {
        graphMessage, mailbox, sender, intent, classifier,
      })
      // intent='reply' sans match parent : on a quand même créé une
      // proposition (fallback). On distingue dans `action` pour qu'un
      // maintainer puisse retrouver les "orphelins de reply" facilement.
      action = (intent === 'reply' && !threadMatch)
        ? 'proposal_created_no_match'
        : 'proposal_created'
    } else {
      // Garde-fou : intent inconnu (ne devrait jamais arriver, validation
      // côté classifier garantit l'enum).
      action = 'skipped_error'
      errorMessage = `unknown intent: ${intent}`
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
