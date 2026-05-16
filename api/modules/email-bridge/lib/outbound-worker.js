// Worker outbox : envoie par mail les messages Opale ajoutés à un ticket
// qui a été ouvert par mail (Phase 4, issue #8).
//
// Sélection :
//   - ticket_messages.email_sent_at IS NULL  (pas encore envoyé)
//   - type = 'comment'                       (on n'envoie pas les system msgs)
//   - le ticket a au moins une mapping row INBOUND (= origine mail)
//
// Loop-protection : le pipeline inbound (processOne action='message_appended')
// crée le ticket_message avec email_sent_at = NOW(), donc le mail entrant
// auto-ajouté ne re-déclenche PAS un envoi sortant vers son auteur original.
//
// Adresse destinataire = from_address du dernier mail INBOUND du ticket.
// Si plusieurs mails inbound de personnes différentes (cas CC, escalade),
// on prend l'expéditeur du DERNIER mail — c'est qui veut sa réponse en ce
// moment. On n'envoie PAS à tous, pour éviter des bruits/surprises.
//
// Erreurs : si Graph échoue, on laisse email_sent_at NULL → retry au tick
// suivant. Idempotent côté Microsoft (sendMail crée un nouveau mail à chaque
// call, donc en cas de retry, on enverra plusieurs fois). Pour limiter :
// on UPDATE email_sent_at PRÉ-envoi avec un timestamp, on tente l'envoi,
// si échec on annule le UPDATE. Trade-off : le retry est volontaire.

import { sendMail } from './graph-send.js'
import { buildThreadHeaders, buildSubject } from './thread-headers.js'

const DEFAULT_INTERVAL_MS = 10_000
const MAX_BATCH = 20  // bound le travail par tick pour ne pas bloquer
let _timer = null

async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key])
  return rows[0]?.value ?? null
}

async function getConfig(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN (
       'mail.send_enabled', 'mail.sender_address', 'mail.sender_display_name'
     )`
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    enabled: map['mail.send_enabled'] === 'true',
    sender:  map['mail.sender_address'] || '',
    senderDisplay: map['mail.sender_display_name'] || '',
  }
}

// Récupère les messages à envoyer, joints au ticket et aux mappings.
// LIMIT pour borner le batch ; trier par created_at ASC pour respecter
// l'ordre chronologique côté destinataire.
async function pickPending(db, limit) {
  const { rows } = await db.query(`
    SELECT tm.id          AS message_id,
           tm.ticket_id,
           tm.author,
           tm.content,
           tm.created_at,
           t.title        AS ticket_title
    FROM ticket_messages tm
    JOIN tickets t ON t.id = tm.ticket_id
    WHERE tm.email_sent_at IS NULL
      AND tm.type = 'comment'
      AND EXISTS (
        SELECT 1 FROM email_thread_mapping etm
        WHERE etm.ticket_id = tm.ticket_id
          AND etm.direction = 'inbound'
      )
    ORDER BY tm.created_at ASC
    LIMIT $1
  `, [limit])
  return rows
}

// Charge tous les mappings d'un ticket, triés chronologiquement.
// Sert à construire In-Reply-To/References + retrouver le destinataire.
async function loadTicketMappings(db, ticketId) {
  const { rows } = await db.query(`
    SELECT internet_message_id, direction, from_address, subject, received_at
    FROM email_thread_mapping
    WHERE ticket_id = $1
    ORDER BY received_at ASC NULLS FIRST, created_at ASC
  `, [ticketId])
  return rows
}

// Sélectionne le destinataire : dernier expéditeur INBOUND non-nul.
function pickRecipient(mappings) {
  for (let i = mappings.length - 1; i >= 0; i--) {
    const m = mappings[i]
    if (m.direction === 'inbound' && m.from_address) return m.from_address
  }
  return null
}

// Sélectionne le subject de base : dernier subject inbound, ou title du
// ticket en fallback.
function pickSubject(mappings, ticketTitle) {
  for (let i = mappings.length - 1; i >= 0; i--) {
    const m = mappings[i]
    if (m.direction === 'inbound' && m.subject) return m.subject
  }
  return ticketTitle || '(sans sujet)'
}

// Marque un message comme envoyé (ou réinitialise en cas d'échec).
async function markSent(db, messageId, sentAt) {
  await db.query(
    `UPDATE ticket_messages SET email_sent_at = $1 WHERE id = $2`,
    [sentAt, messageId]
  )
}

// Process un message : assemble le mail, envoie via Graph, marque la row.
// Retourne 'sent' | 'skipped_no_recipient' | 'error'.
export async function sendOne(db, log, { message, sender, sendImpl = sendMail }) {
  const mappings = await loadTicketMappings(db, message.ticket_id)
  if (!mappings.length) {
    // Théoriquement impossible : la requête pickPending exige EXISTS d'un
    // inbound. Garde-fou défensif au cas où le mapping serait supprimé
    // entre-temps.
    return 'skipped_no_recipient'
  }

  const recipient = pickRecipient(mappings)
  if (!recipient) {
    log?.warn({ ticketId: message.ticket_id, messageId: message.message_id },
      'outbound: pas de destinataire (mapping sans from_address), skip')
    return 'skipped_no_recipient'
  }

  const baseSubject = pickSubject(mappings, message.ticket_title)
  const subject = buildSubject(baseSubject, message.ticket_id)
  const { inReplyTo, references } = buildThreadHeaders(mappings)

  // Marquer PRÉ-envoi : évite un double-send si le worker tick deux fois
  // pendant que Graph est lent. Si l'envoi échoue, on réinitialise.
  const now = new Date()
  await markSent(db, message.message_id, now)

  try {
    await sendImpl({
      sender,
      to: recipient,
      subject,
      bodyText: message.content,
      inReplyTo,
      references,
    })
    log?.info({
      ticketId: message.ticket_id, messageId: message.message_id,
      recipient, subject,
    }, 'outbound: mail envoyé')
    return 'sent'
  } catch (err) {
    // Échec → on annule la marque pour autoriser un retry au prochain tick.
    await markSent(db, message.message_id, null)
    log?.warn({ err: err.message, messageId: message.message_id }, 'outbound: send a échoué, retry au prochain tick')
    return 'error'
  }
}

// Un tick de l'outbox.
export async function flushOutbox(db, log, { sendImpl } = {}) {
  const cfg = await getConfig(db)
  if (!cfg.enabled) return { skipped: 'disabled' }
  if (!cfg.sender)  return { skipped: 'no-sender-configured' }

  const pending = await pickPending(db, MAX_BATCH)
  if (!pending.length) return { sent: 0, skipped_no_recipient: 0, errors: 0 }

  const stats = { sent: 0, skipped_no_recipient: 0, errors: 0 }
  for (const message of pending) {
    try {
      const r = await sendOne(db, log, { message, sender: cfg.sender, sendImpl })
      if      (r === 'sent')                  stats.sent++
      else if (r === 'skipped_no_recipient')  stats.skipped_no_recipient++
      else                                    stats.errors++
    } catch (err) {
      stats.errors++
      log?.warn({ err: err.message, messageId: message.message_id }, 'outbound: sendOne a planté')
    }
  }
  return stats
}

export function startMailOutboundWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return
  const run = () =>
    flushOutbox(db, log).catch(err =>
      log?.warn({ err: err.message }, 'outbound: tick a planté')
    )
  setTimeout(run, 7_000)  // décalé du polling inbound (5s) pour étaler la charge
  _timer = setInterval(run, intervalMs)
  log?.info({ intervalMs }, 'email-bridge: worker outbound démarré')
}

export function stopMailOutboundWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
}
