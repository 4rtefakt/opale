// Pipeline d'ingestion d'un mail ENVOYÉ depuis Outlook (issue #8, extension).
//
// Quand un agent répond à un fil de ticket depuis sa boîte perso au lieu de
// cliquer "Répondre" dans Opale, sa réponse n'apparaît pas dans la
// conversation. On scanne ses Éléments envoyés et, pour chaque mail :
//   1. Pré-check idempotence : déjà dans email_thread_mapping ? → skip.
//   2. matchThread (In-Reply-To / References / conversationId) → ticket ?
//   3a. Match sur ticket existant → append message 'comment' au ticket,
//       avec email_sent_at = sentDateTime (déjà envoyé → l'outbox l'ignore)
//       et created_at = sentDateTime (placement chronologique correct, utile
//       surtout pour le backfill de mails vieux de plusieurs semaines).
//   3b. Pas de match ticket → 'skipped_no_match'. AUCUNE ligne mapping écrite :
//       on ne stocke pas le courrier perso non lié à un ticket (vie privée +
//       volume). Conséquence : un mail non-matché sera ré-évalué si re-scanné,
//       mais matchThread est bon marché et idempotent (pas d'append en double).
//
// Volontairement PAS de classifieur, PAS de création de ticket, PAS de
// pending_review : la demande est "seulement les mails liés à un ticket déjà
// existant". Un mail sans en-têtes de thread n'est donc reliable à rien.

import { matchSender } from './match-sender.js'
import { matchThread } from './match-thread.js'
import { getMessage }  from './graph-mail.js'
import { extractMailBodyText, htmlToText } from './body-text.js'

function indexHeaders(graphMessage) {
  const idx = {}
  for (const h of graphMessage?.internetMessageHeaders || []) {
    if (h?.name) idx[h.name.toLowerCase()] = h.value || ''
  }
  return idx
}

function safeBodyPreview(graphMessage) {
  return htmlToText(graphMessage?.bodyPreview || '').slice(0, 1000)
}

// Date de référence du mail sortant : sentDateTime en priorité, fallback sur
// receivedDateTime puis maintenant. Sert à la fois pour created_at (placement
// dans le fil) et email_sent_at (marqueur "déjà envoyé").
function sentAt(graphMessage) {
  return graphMessage?.sentDateTime || graphMessage?.receivedDateTime || new Date().toISOString()
}

async function appendSentMessageToTicket(client, { ticketId, authorName, content, when }) {
  await client.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
    VALUES ($1, 'comment', $2, $3, $4, $4)
  `, [ticketId, authorName, content, when])
  await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticketId])
}

// Traite un seul mail envoyé. `getMessageFn` est injectable pour les tests.
//
// Retour : { action, ticket_id? }
//   action : 'message_appended' | 'skipped_no_match' | 'already_ingested'
//            | 'skipped_error'
export async function processSentOne(db, log, { graphMessage, mailbox, getMessageFn = getMessage }) {
  const internetMessageId = graphMessage?.internetMessageId
  if (!internetMessageId) {
    log?.warn({ mailbox, graphId: graphMessage?.id }, 'sent: mail sans internetMessageId, skip')
    return { action: 'skipped_error', error: 'no internetMessageId' }
  }

  // Idempotence : déjà ingéré (par ce worker, ou comme inbound si l'agent
  // s'était mis en copie) → on ne touche à rien. L'UNIQUE sur
  // internet_message_id garantit qu'on n'append jamais deux fois la réponse.
  {
    const { rows } = await db.query(
      `SELECT id FROM email_thread_mapping WHERE internet_message_id = $1`,
      [internetMessageId]
    )
    if (rows.length) return { action: 'already_ingested' }
  }

  const headers = indexHeaders(graphMessage)
  const threadMatch = await matchThread(db, {
    inReplyToHeader:  headers['in-reply-to'] || null,
    referencesHeader: headers['references']  || null,
    conversationId:   graphMessage.conversationId || null,
    subject:          graphMessage.subject   || null,
  })

  // Seuls les threads rattachés à un TICKET existant nous intéressent. Une
  // proposal pending n'est pas (encore) un ticket → on ne touche pas.
  if (!threadMatch?.ticket_id) {
    return { action: 'skipped_no_match' }
  }

  const fromAddress = graphMessage.from?.emailAddress?.address || null

  // Corps complet (strippé de la signature ET du bloc cité Outlook par
  // extractMailBodyText) pour ne garder que le texte neuf de la réponse.
  // Si getMessage échoue (réseau / perm), on retombe sur le bodyPreview.
  let bodyText = null
  try {
    const full = await getMessageFn(mailbox, graphMessage.id)
    bodyText = extractMailBodyText(graphMessage, full)
  } catch (err) {
    log?.warn({ err: err.message, internetMessageId },
      'sent: full body fetch failed, fallback bodyPreview')
  }

  const sender = await matchSender(db, fromAddress)
  const authorName = sender.user_name || fromAddress || 'Email'
  const content = bodyText || safeBodyPreview(graphMessage) || '(corps vide)'
  const when = sentAt(graphMessage)

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // INSERT mapping en premier sous ON CONFLICT DO NOTHING : si un autre tick
    // a gagné la course, rowCount=0 → rollback + already_ingested.
    const insertMapping = await client.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, conversation_id, graph_message_id,
         mailbox, direction, from_address, subject, received_at, raw,
         processed_at, action, ticket_id)
      VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, now(), 'message_appended', $9)
      ON CONFLICT (internet_message_id) DO NOTHING
      RETURNING id
    `, [
      internetMessageId,
      graphMessage.conversationId || null,
      graphMessage.id || null,
      mailbox,
      fromAddress,
      graphMessage.subject || null,
      when,
      JSON.stringify(graphMessage),
      threadMatch.ticket_id,
    ])
    if (insertMapping.rowCount === 0) {
      await client.query('ROLLBACK')
      return { action: 'already_ingested' }
    }

    await appendSentMessageToTicket(client, {
      ticketId: threadMatch.ticket_id, authorName, content, when,
    })

    await client.query('COMMIT')
    return { action: 'message_appended', ticket_id: threadMatch.ticket_id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log?.warn({ err: err.message, mailbox, internetMessageId }, 'sent: tx process échouée')
    return { action: 'skipped_error', error: err.message }
  } finally {
    client.release()
  }
}
