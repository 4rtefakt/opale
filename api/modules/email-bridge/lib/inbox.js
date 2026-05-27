// Helpers pour la vue "Mails à trier" (Phase 3).
//
// L'admin décide manuellement, sur chaque mail entrant sans thread match,
// si c'est un ticket (→ /to-ticket) ou à ignorer (→ /dismiss). Plus de
// classification automatique en proposal/other — le classifier reste
// appelé pour fournir une suggestion visuelle, sans effet sur l'action.

import { extractMailBodyText, htmlToText } from './body-text.js'
import { getMessage } from './graph-mail.js'
import { matchSender } from './match-sender.js'
import { syncRequester, addDeviceToTicket } from '../../tickets/lib/relations.js'

// Strip standard des préfixes Outlook sur le subject pour un titre lisible.
// Identique à la logique inline de createProposal (process-mail.js) — à
// extraire si on en trouve un 3e usage.
function cleanSubject(s) {
  return (s || '(sans sujet)')
    .replace(/^\s*(re|tr|fwd|fw)\s*:\s*/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .trim() || '(sans sujet)'
}

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

// Crée un ticket à partir d'un mapping en attente de tri.
// Pré-conditions : le mapping existe et son action est 'pending_review'.
// Side effects : INSERT tickets + ticket_messages + ticket_users + ticket_devices,
// UPDATE mapping (ticket_id, action='message_appended').
// Retourne l'objet ticket créé.
export async function createTicketFromMapping(client, log, { mappingId, byEntraId, byName }) {
  const { rows: mapRows } = await client.query(
    `SELECT id, mailbox, internet_message_id, graph_message_id, conversation_id,
            from_address, subject, received_at, raw, action, ticket_id
     FROM email_thread_mapping
     WHERE id = $1 FOR UPDATE`,
    [mappingId]
  )
  if (!mapRows.length) throw new Error('MAPPING_NOT_FOUND')
  const m = mapRows[0]
  if (m.ticket_id) throw new Error('ALREADY_LINKED')

  // `raw` contient le graphMessage complet du polling (cf. processOne).
  // Microsoft Graph y stocke `bodyPreview` (plain text borné ~255 chars)
  // mais PAS body.content (le full HTML/text). Pour avoir le corps complet
  // on doit refaire un appel getMessage à la demande.
  const graphMessage = m.raw || {}
  const fromName = graphMessage.from?.emailAddress?.name || m.from_address || 'expéditeur inconnu'

  // Best-effort : fetch full body. En cas d'erreur Graph (token expiré,
  // mail supprimé), on retombe sur bodyPreview du raw — pas bloquant.
  let bodyText = null
  try {
    if (m.mailbox && m.graph_message_id) {
      const full = await getMessage(m.mailbox, m.graph_message_id)
      bodyText = extractMailBodyText(graphMessage, full)
    }
  } catch (err) {
    log?.warn({ err: err.message, mappingId },
      'inbox.createTicketFromMapping: fetch full body échoué, fallback bodyPreview')
  }
  if (!bodyText) bodyText = htmlToText(graphMessage.bodyPreview || '')

  // Match expéditeur → suggère un requester + device. Pas bloquant non plus
  // (les colonnes restent NULL si pas de match).
  const sender = await matchSender(client, m.from_address).catch(() => ({}))

  const title = cleanSubject(m.subject).slice(0, 200)
  const dateFr = formatDateFr(m.received_at)
  const description = dateFr ? `Mail de ${fromName} reçu le ${dateFr}` : `Mail de ${fromName}`

  const { rows: tRows } = await client.query(`
    INSERT INTO tickets
      (title, description, priority, device_id, user_id, source, is_auto,
       created_by_entra_id, created_by_name)
    VALUES ($1, $2, 'normal', $3, $4, 'email', true, $5, $6)
    RETURNING *
  `, [title, description, sender.device_id || null, sender.user_id || null,
      byEntraId, byName])
  const tk = tRows[0]

  // Phase 1a — premier message = corps du mail (email_sent_at=now() : mail
  // déjà reçu, l'outbox ne doit pas le ré-envoyer).
  if (bodyText) {
    await client.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
      VALUES ($1, 'comment', $2, $3, now(), COALESCE($4::timestamptz, now()))
    `, [tk.id, fromName, bodyText, m.received_at || null])
  }

  // Phase 2 — peuple les M2M (idem POST /tickets / accept proposal)
  if (tk.user_id)   await syncRequester(client, tk.id, tk.user_id)
  if (tk.device_id) await addDeviceToTicket(client, tk.id, tk.device_id)

  // Repointe le mapping vers le nouveau ticket. Action 'message_appended'
  // (cohérent avec le cas thread match : un mail → un ticket, message
  // attaché).
  await client.query(
    `UPDATE email_thread_mapping SET ticket_id = $1, action = 'message_appended', processed_at = now() WHERE id = $2`,
    [tk.id, mappingId]
  )

  return tk
}

// Marque un mapping pending_review comme ignoré sans créer de ticket.
// Idempotent : si déjà skipped_other, no-op.
export async function dismissInboxMapping(client, mappingId) {
  const { rows } = await client.query(
    `SELECT action FROM email_thread_mapping WHERE id = $1 FOR UPDATE`,
    [mappingId]
  )
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  if (rows[0].action === 'skipped_other') return false // déjà ignoré
  if (rows[0].action !== 'pending_review') throw new Error('NOT_PENDING')

  await client.query(
    `UPDATE email_thread_mapping SET action = 'skipped_other', processed_at = now() WHERE id = $1`,
    [mappingId]
  )
  return true
}
