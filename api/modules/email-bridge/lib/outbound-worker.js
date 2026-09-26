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
// on RÉCLAME le message PRÉ-envoi (UPDATE email_sent_at … WHERE
// email_sent_at IS NULL, atomique : un seul tick / une seule instance
// l'obtient), on tente l'envoi, si échec on annule la marque. Trade-off :
// le retry est volontaire ; un crash entre la réclamation et l'envoi laisse
// le message marqué (au plus une fois plutôt qu'en double).

import { sendMail, sendReply } from './graph-send.js'
import { buildSubject } from './thread-headers.js'
import { nonOverlapping } from '../../../lib/non-overlapping.js'

const DEFAULT_INTERVAL_MS = 10_000
const MAX_BATCH = 20  // bound le travail par tick pour ne pas bloquer
const MAX_ATTEMPTS = 5 // au-delà → dead-letter (≈ 50s de retries à 10s/tick)
let _timer = null
let _kickoff = null
let _run = null

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
           tm.outbound_attempts,
           t.title        AS ticket_title
    FROM ticket_messages tm
    JOIN tickets t ON t.id = tm.ticket_id
    WHERE tm.email_sent_at IS NULL
      AND tm.outbound_failed_at IS NULL   -- exclut les dead-letters
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
// Sert à retrouver le destinataire + la cible de réponse threadée.
async function loadTicketMappings(db, ticketId) {
  const { rows } = await db.query(`
    SELECT internet_message_id, graph_message_id, mailbox, direction,
           from_address, subject, received_at
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

// Cible de réponse threadée : dernier mail INBOUND ayant un graph_message_id
// (+ sa mailbox). Permet le createReply natif. null si aucun (vieux mappings
// pré-graph_message_id) → le caller fait un fallback sendMail.
function pickReplyTarget(mappings) {
  for (let i = mappings.length - 1; i >= 0; i--) {
    const m = mappings[i]
    if (m.direction === 'inbound' && m.graph_message_id && m.mailbox) {
      return { mailbox: m.mailbox, graphMessageId: m.graph_message_id }
    }
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

// Réclame un message avant envoi : pose email_sent_at SEULEMENT s'il est
// encore en attente. Atomique côté Postgres — deux ticks qui se chevauchent
// (ou deux instances) ont pu lire le même message dans pickPending, un seul
// obtient la ligne. Retourne le compteur de tentatives courant, ou null si
// un autre tick l'a déjà pris (ou s'il est passé en dead-letter entre-temps).
async function claimForSend(db, messageId, sentAt) {
  const { rows } = await db.query(
    `UPDATE ticket_messages SET email_sent_at = $1
     WHERE id = $2 AND email_sent_at IS NULL AND outbound_failed_at IS NULL
     RETURNING outbound_attempts`,
    [sentAt, messageId]
  )
  return rows.length ? rows[0].outbound_attempts : null
}

// Gère un échec d'envoi : incrémente le compteur, annule la marque d'envoi,
// et passe en dead-letter (outbound_failed_at) si on a épuisé les tentatives.
// Retourne true si dead-letter (abandon), false si on retentera.
async function markFailure(db, messageId, attemptsBefore, errMsg) {
  const attempts = (attemptsBefore || 0) + 1
  const deadLetter = attempts >= MAX_ATTEMPTS
  await db.query(`
    UPDATE ticket_messages
    SET email_sent_at = NULL,
        outbound_attempts = $1,
        outbound_error = $2,
        outbound_failed_at = $3
    WHERE id = $4
  `, [attempts, (errMsg || '').slice(0, 500), deadLetter ? new Date() : null, messageId])
  return deadLetter
}

// Process un message : envoie via Graph (réponse threadée si possible,
// sinon mail simple), marque la row. Retourne 'sent' |
// 'skipped_no_recipient' | 'skipped_claimed' (pris par un autre tick) |
// 'dead_letter' | 'error'.
//
// sendReplyImpl / sendImpl injectables pour les tests.
export async function sendOne(db, log, {
  message, sender, sendImpl = sendMail, sendReplyImpl = sendReply,
}) {
  const mappings = await loadTicketMappings(db, message.ticket_id)
  if (!mappings.length) {
    // Théoriquement impossible : pickPending exige EXISTS d'un inbound.
    // Garde-fou si le mapping a été supprimé entre-temps.
    return 'skipped_no_recipient'
  }

  const recipient = pickRecipient(mappings)
  if (!recipient) {
    log?.warn({ ticketId: message.ticket_id, messageId: message.message_id },
      'outbound: pas de destinataire (mapping sans from_address), skip')
    return 'skipped_no_recipient'
  }

  const replyTarget = pickReplyTarget(mappings)

  // Réclamer PRÉ-envoi : évite un double-send si le worker tick deux fois
  // pendant que Graph est lent. Si l'envoi échoue, on réinitialise.
  const attemptsBefore = await claimForSend(db, message.message_id, new Date())
  if (attemptsBefore === null) return 'skipped_claimed'

  // Envoi en mail neuf (fallback) : pas de threading, pas de headers
  // In-Reply-To/References (rejetés par Graph). Réutilisé par le chemin
  // "pas de cible" ET par le fallback 404 ci-dessous.
  const sendNew = () => {
    const subject = buildSubject(pickSubject(mappings, message.ticket_title), message.ticket_id)
    return sendImpl({ sender, to: recipient, subject, bodyText: message.content })
  }

  try {
    let mode = 'new'
    if (replyTarget) {
      // Mode normal : réponse nativement threadée (Graph gère headers + sujet).
      try {
        await sendReplyImpl({
          mailbox: replyTarget.mailbox,
          graphMessageId: replyTarget.graphMessageId,
          bodyText: message.content,
        })
        mode = 'reply'
      } catch (err) {
        // Le mail d'origine n'existe plus côté Outlook (supprimé, déplacé,
        // archivé) → createReply renvoie 404 ItemNotFound. Inutile de
        // retenter à l'infini : on bascule sur un mail neuf. Les autres
        // erreurs (réseau, throttling, 5xx) restent transitoires → on
        // relance pour permettre un vrai retry au prochain tick.
        if (/createReply: 404/.test(err.message)) {
          log?.warn({ ticketId: message.ticket_id, messageId: message.message_id },
            'outbound: mail d\'origine introuvable (404), fallback mail neuf')
          await sendNew()
          mode = 'new-fallback'
        } else {
          throw err
        }
      }
    } else {
      await sendNew()
    }
    log?.info({
      ticketId: message.ticket_id, messageId: message.message_id,
      recipient, mode,
    }, 'outbound: mail envoyé')
    return 'sent'
  } catch (err) {
    // Échec → compteur + éventuel dead-letter. markFailure annule la marque
    // d'envoi (retry possible) tant qu'on n'a pas atteint MAX_ATTEMPTS ;
    // au-delà, le message est mis de côté (outbound_failed_at) et n'est plus
    // repris automatiquement — l'admin le relance manuellement depuis l'UI.
    const deadLetter = await markFailure(db, message.message_id, attemptsBefore, err.message)
    log?.warn({
      err: err.message, messageId: message.message_id,
      attempts: (attemptsBefore || 0) + 1, deadLetter,
    }, deadLetter
      ? 'outbound: abandon après MAX_ATTEMPTS, message en échec (dead-letter)'
      : 'outbound: send a échoué, retry au prochain tick')
    return deadLetter ? 'dead_letter' : 'error'
  }
}

// Un tick de l'outbox.
export async function flushOutbox(db, log, { sendImpl, sendReplyImpl } = {}) {
  const cfg = await getConfig(db)
  if (!cfg.enabled) return { skipped: 'disabled' }
  if (!cfg.sender)  return { skipped: 'no-sender-configured' }

  const pending = await pickPending(db, MAX_BATCH)
  if (!pending.length) return { sent: 0, skipped_no_recipient: 0, skipped_claimed: 0, errors: 0, dead_letter: 0 }

  const stats = { sent: 0, skipped_no_recipient: 0, skipped_claimed: 0, errors: 0, dead_letter: 0 }
  for (const message of pending) {
    try {
      const r = await sendOne(db, log, { message, sender: cfg.sender, sendImpl, sendReplyImpl })
      if      (r === 'sent')                  stats.sent++
      else if (r === 'skipped_no_recipient')  stats.skipped_no_recipient++
      else if (r === 'skipped_claimed')       stats.skipped_claimed++
      else if (r === 'dead_letter')           stats.dead_letter++
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
  // Un seul tick à la fois : si Graph est lent, le tick suivant ne relit pas
  // les mêmes messages en parallèle (la réclamation atomique de sendOne
  // protège en plus contre une 2e instance de l'API).
  _run = nonOverlapping(() => flushOutbox(db, log), {
    onError: err => log?.warn({ err: err.message }, 'outbound: tick a planté'),
  })
  _kickoff = setTimeout(_run, 7_000)  // décalé du polling inbound (5s) pour étaler la charge
  _timer = setInterval(_run, intervalMs)
  log?.info({ intervalMs }, 'email-bridge: worker outbound démarré')
}

// Arrête le worker et attend la fin du tick en cours (pas d'arrêt entre la
// réclamation d'un message et l'enregistrement du résultat de l'envoi).
export async function stopMailOutboundWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_kickoff) { clearTimeout(_kickoff); _kickoff = null }
  if (_run) { const run = _run; _run = null; await run.idle() }
}
