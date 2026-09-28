// Helpers pour la vue "Mails à trier" (Phase 3).
//
// L'admin décide manuellement, sur chaque mail entrant sans thread match,
// si c'est un ticket (→ /to-ticket), s'il complète un ticket existant
// (→ /attach) ou s'il est à ignorer (→ /dismiss). Plus de classification
// automatique en proposal/other — le classifier reste appelé pour fournir
// une suggestion visuelle, sans effet sur l'action.
//
// Fil complet : quand un mail devient un ticket (ou rejoint un ticket), on
// n'y met pas QUE ce mail. On ramasse tout son fil :
//   1. les autres mails ingérés du même fil (même conversationId Outlook,
//      ou reliés par In-Reply-To / References) encore à trier ou mis de
//      côté, non rattachés à un ticket ;
//   2. best-effort, les mails du même fil encore présents dans la boîte
//      mais jamais ingérés (antérieurs à la mise en place du polling,
//      réponses de l'équipe faites depuis Outlook) via Graph.
// Chaque mail devient un message du ticket, à sa date de réception, et son
// mapping est repointé sur le ticket — les réponses suivantes du fil sont
// ainsi rattachées automatiquement par matchThread.

import { extractMailBodyText, htmlToText, isForwardedSubject } from './body-text.js'
import { getMessage, listConversationMessages } from './graph-mail.js'
import { matchSender } from './match-sender.js'
import { stripNul } from './sanitize.js'
import { parseMessageIdList } from './header-parser.js'
import { storedMessageId, messageIdLookupKeys } from './message-id.js'
import { syncRequester, addInvolvedUser, addDeviceToTicket } from '../../tickets/lib/relations.js'

// Nombre max de mails récupérés depuis Graph pour compléter un fil (un
// appel getMessage par mail pour le corps complet).
const GRAPH_THREAD_MAX = 20

// Strip standard des préfixes Outlook sur le subject pour un titre lisible.
export function cleanSubject(s) {
  return (s || '(sans sujet)')
    .replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '')
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

function indexHeaders(graphMessage) {
  const idx = {}
  for (const h of graphMessage?.internetMessageHeaders || []) {
    if (h?.name) idx[h.name.toLowerCase()] = h.value || ''
  }
  return idx
}

// Message-IDs référencés par un mail (In-Reply-To + References), normalisés.
function referencedIds(graphMessage) {
  const h = indexHeaders(graphMessage)
  return [...new Set([...parseMessageIdList(h['in-reply-to']), ...parseMessageIdList(h['references'])])]
}

function senderOf(graphMessage) {
  return {
    address: graphMessage?.from?.emailAddress?.address || null,
    name:    graphMessage?.from?.emailAddress?.name || null,
  }
}

// ── Fil côté DB ──────────────────────────────────────────────────────────────

// Mails ingérés appartenant au même fil que `m`, non rattachés à un ticket
// ni à une proposition : même conversation_id, ou reliés par les en-têtes
// de threading (dans les deux sens). Ordre chronologique.
export async function findThreadSiblings(db, m) {
  const raw = m.raw || {}
  const ownIds = messageIdLookupKeys(raw.internetMessageId || m.internet_message_id)
  const refIds = referencedIds(raw).flatMap(messageIdLookupKeys)

  const { rows } = await db.query(`
    SELECT id, mailbox, internet_message_id, graph_message_id, conversation_id,
           direction, from_address, subject, received_at, raw, action
    FROM email_thread_mapping
    WHERE id <> $1
      AND ticket_id IS NULL AND proposal_id IS NULL
      AND (action IN ('pending_review', 'skipped_other') OR action IS NULL)
      AND (
        ($2::text IS NOT NULL AND conversation_id = $2)
        OR internet_message_id = ANY($3::text[])
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(raw->'internetMessageHeaders') = 'array'
                 THEN raw->'internetMessageHeaders' ELSE '[]'::jsonb END) h
          WHERE lower(h->>'name') IN ('in-reply-to', 'references')
            AND EXISTS (SELECT 1 FROM unnest($4::text[]) own WHERE position(own IN (h->>'value')) > 0)
        )
      )
    ORDER BY received_at ASC NULLS LAST, created_at ASC
  `, [m.id, m.conversation_id || null, refIds, ownIds.map(id => String(id).replace(/^<|>$/g, ''))])
  return rows
}

// ── Fil côté Graph (best-effort) ────────────────────────────────────────────

// Mails de la même conversation Outlook encore dans la boîte mais absents
// de email_thread_mapping. Retourne des objets { graphMessage, direction }.
// Toute erreur Graph (token, perm, boîte) est avalée : le fil DB suffit.
async function fetchMissingConversationMessages(db, log, m, knownIds) {
  if (!m.mailbox || !m.conversation_id) return []
  let page
  try {
    page = await listConversationMessages(m.mailbox, m.conversation_id, { top: 50 })
  } catch (err) {
    log?.warn({ err: err.message, mappingId: m.id }, 'inbox: listing conversation Graph échoué, fil DB seul')
    return []
  }
  const mailbox = String(m.mailbox).toLowerCase()
  const out = []
  for (const g of page.value) {
    if (!g?.internetMessageId) continue
    if (knownIds.has(storedMessageId(g.internetMessageId)) || knownIds.has(g.internetMessageId)) continue
    // Déjà en base sous une autre forme (ligne rattachée à un autre ticket…) ?
    const { rows } = await db.query(
      `SELECT 1 FROM email_thread_mapping WHERE internet_message_id = ANY($1)`,
      [messageIdLookupKeys(g.internetMessageId)]
    )
    if (rows.length) continue
    const fromAddr = String(senderOf(g).address || '').toLowerCase()
    const direction = (page.sentFolderId && g.parentFolderId === page.sentFolderId) || (fromAddr && fromAddr === mailbox)
      ? 'outbound' : 'inbound'
    out.push({ graphMessage: stripNul(g), direction })
    if (out.length >= GRAPH_THREAD_MAX) break
  }
  return out
}

// ── Corps d'un mail ─────────────────────────────────────────────────────────

// Corps complet via Graph (best-effort), sinon bodyPreview. Toujours du
// texte propre sans NUL. `keepQuoted` pour un mail transféré : la citation
// EST l'historique qu'on veut.
async function fetchBodyText(log, { mailbox, graphMessageId, graphMessage, mappingId }) {
  const keepQuoted = isForwardedSubject(graphMessage?.subject)
  let bodyText = null
  try {
    if (mailbox && graphMessageId) {
      const full = await getMessage(mailbox, graphMessageId)
      bodyText = extractMailBodyText(graphMessage, full, { keepQuoted })
    }
  } catch (err) {
    log?.warn({ err: err.message, mappingId },
      'inbox: fetch full body échoué, fallback bodyPreview')
  }
  if (!bodyText) bodyText = htmlToText(graphMessage?.bodyPreview || '')
  return stripNul(bodyText)
}

// ── Assemblage du fil ───────────────────────────────────────────────────────

// Construit la liste ordonnée des mails à verser dans un ticket à partir du
// mapping `m` (verrouillé par l'appelant). Chaque item :
//   { mappingId?, graphMessage, direction, mailbox, graphMessageId,
//     fromAddress, fromName, subject, receivedAt, bodyText }
async function assembleThread(client, log, m) {
  const siblings = await findThreadSiblings(client, m)
  const knownIds = new Set()
  for (const r of [m, ...siblings]) {
    knownIds.add(r.internet_message_id)
    if (r.raw?.internetMessageId) knownIds.add(r.raw.internetMessageId)
  }
  const extras = await fetchMissingConversationMessages(client, log, m, knownIds)

  const items = []
  for (const r of [m, ...siblings]) {
    const g = r.raw || {}
    items.push({
      mappingId: r.id, graphMessage: g, direction: r.direction || 'inbound',
      mailbox: r.mailbox, graphMessageId: r.graph_message_id,
      fromAddress: r.from_address || senderOf(g).address,
      fromName: senderOf(g).name || r.from_address || 'expéditeur inconnu',
      subject: r.subject || g.subject || null,
      receivedAt: r.received_at || g.receivedDateTime || null,
    })
  }
  for (const e of extras) {
    const g = e.graphMessage
    items.push({
      mappingId: null, graphMessage: g, direction: e.direction,
      mailbox: m.mailbox, graphMessageId: g.id,
      fromAddress: senderOf(g).address,
      fromName: senderOf(g).name || senderOf(g).address || 'expéditeur inconnu',
      subject: g.subject || null,
      receivedAt: g.receivedDateTime || g.sentDateTime || null,
    })
  }
  items.sort((a, b) => Date.parse(a.receivedAt || 0) - Date.parse(b.receivedAt || 0))

  for (const it of items) {
    it.bodyText = await fetchBodyText(log, {
      mailbox: it.mailbox, graphMessageId: it.graphMessageId,
      graphMessage: it.graphMessage, mappingId: it.mappingId,
    })
  }
  return items
}

// Verse les items dans le ticket : messages + mappings (repointés ou créés).
async function appendThreadToTicket(client, ticketId, items) {
  let appended = 0
  for (const it of items) {
    const content = it.bodyText || '(corps vide)'
    // email_sent_at = now() : ce message vient déjà d'un mail, l'outbox ne
    // doit pas le renvoyer. created_at = date du mail → ordre chronologique.
    await client.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
      VALUES ($1, 'comment', $2, $3, now(), COALESCE($4::timestamptz, now()))
    `, [ticketId, it.fromName, content, it.receivedAt || null])
    appended++

    if (it.mappingId) {
      await client.query(
        `UPDATE email_thread_mapping
         SET ticket_id = $1, action = 'message_appended', processed_at = now(), error_message = NULL
         WHERE id = $2`,
        [ticketId, it.mappingId]
      )
    } else {
      const g = it.graphMessage
      await client.query(`
        INSERT INTO email_thread_mapping
          (internet_message_id, conversation_id, graph_message_id, mailbox, direction,
           from_address, subject, received_at, raw, processed_at, action, ticket_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), 'message_appended', $10)
        ON CONFLICT (internet_message_id) DO NOTHING
      `, [
        storedMessageId(g.internetMessageId), g.conversationId || null, g.id || null,
        it.mailbox, it.direction, it.fromAddress, it.subject, it.receivedAt || null,
        JSON.stringify(g), ticketId,
      ])
    }
  }
  await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticketId])
  return appended
}

// Expéditeurs externes du fil (hors boîte de réception), dédoublonnés, dans
// l'ordre chronologique. Le premier reconnu comme utilisateur Opale devient
// demandeur, les autres reconnus sont « concernés ».
async function matchThreadSenders(client, items, mailbox) {
  const box = String(mailbox || '').toLowerCase()
  const seen = new Set()
  const matched = []
  for (const it of items) {
    const addr = String(it.fromAddress || '').toLowerCase()
    if (!addr || addr === box || seen.has(addr) || it.direction === 'outbound') continue
    seen.add(addr)
    const s = await matchSender(client, addr).catch(() => ({}))
    if (s.user_id) matched.push(s)
  }
  return matched
}

async function lockMapping(client, mappingId) {
  const { rows } = await client.query(
    `SELECT id, mailbox, internet_message_id, graph_message_id, conversation_id,
            direction, from_address, subject, received_at, raw, action, ticket_id, proposal_id
     FROM email_thread_mapping
     WHERE id = $1 FOR UPDATE`,
    [mappingId]
  )
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  if (rows[0].ticket_id) throw new Error('ALREADY_LINKED')
  return rows[0]
}

// Crée un ticket à partir d'un mapping en attente de tri, avec tout son fil.
// Retourne l'objet ticket créé, enrichi de `absorbed_count` (nombre de mails
// versés dans le ticket, celui-ci compris).
export async function createTicketFromMapping(client, log, { mappingId, byEntraId, byName }) {
  const m = await lockMapping(client, mappingId)
  const items = await assembleThread(client, log, m)

  const senders = await matchThreadSenders(client, items, m.mailbox)
  const requester = senders[0] || {}

  const title = cleanSubject(m.subject).slice(0, 200)
  const first = items[0]
  const last  = items[items.length - 1]
  const firstDate = formatDateFr(first?.receivedAt)
  const lastDate  = formatDateFr(last?.receivedAt)
  let description
  if (items.length > 1) {
    description = `Fil de ${items.length} mails — premier mail de ${first.fromName}`
      + (firstDate ? ` le ${firstDate}` : '')
      + (lastDate ? `, dernier le ${lastDate}` : '')
  } else {
    const fromName = first?.fromName || m.from_address || 'expéditeur inconnu'
    description = firstDate ? `Mail de ${fromName} reçu le ${firstDate}` : `Mail de ${fromName}`
  }

  const { rows: tRows } = await client.query(`
    INSERT INTO tickets
      (title, description, priority, device_id, user_id, source, is_auto,
       created_by_entra_id, created_by_name)
    VALUES ($1, $2, 'normal', $3, $4, 'email', true, $5, $6)
    RETURNING *
  `, [title, description, requester.device_id || null, requester.user_id || null,
      byEntraId, byName])
  const tk = tRows[0]

  const appended = await appendThreadToTicket(client, tk.id, items)

  if (tk.user_id)   await syncRequester(client, tk.id, tk.user_id)
  if (tk.device_id) await addDeviceToTicket(client, tk.id, tk.device_id)
  for (const s of senders.slice(1)) await addInvolvedUser(client, tk.id, s.user_id)

  tk.absorbed_count = appended
  return tk
}

// Rattache un mail en attente (et son fil) à un ticket EXISTANT : le mail
// était en réalité la suite d'une demande déjà ouverte.
// Retourne { ticket_id, appended }.
export async function attachMappingToTicket(client, log, { mappingId, ticketId }) {
  const m = await lockMapping(client, mappingId)
  const { rows: tRows } = await client.query(
    `SELECT id, status, merged_into FROM tickets WHERE id = $1 FOR UPDATE`, [ticketId]
  )
  if (!tRows.length) throw new Error('TICKET_NOT_FOUND')
  if (tRows[0].status === 'merged') throw new Error('TICKET_MERGED')

  const items = await assembleThread(client, log, m)
  const appended = await appendThreadToTicket(client, ticketId, items)

  // Un ticket résolu / archivé qui reçoit un nouveau mail est rouvert :
  // sinon la réponse du demandeur passerait inaperçue.
  if (['resolved', 'closed'].includes(tRows[0].status)) {
    await client.query(
      `UPDATE tickets SET status = 'open', resolved_at = NULL, updated_at = now() WHERE id = $1`, [ticketId]
    )
    await client.query(
      `INSERT INTO ticket_messages (ticket_id, type, author, content)
       VALUES ($1, 'system', 'Opale', 'Ticket rouvert : nouveau mail rattaché')`, [ticketId]
    )
  }

  const senders = await matchThreadSenders(client, items, m.mailbox)
  for (const s of senders) await addInvolvedUser(client, ticketId, s.user_id)

  return { ticket_id: ticketId, appended }
}

// Marque un mapping pending_review comme ignoré sans créer de ticket.
// Idempotent : si déjà skipped_other, no-op. `wholeThread` : ignore aussi
// les autres mails du même fil encore à trier.
export async function dismissInboxMapping(client, mappingId, { wholeThread = false } = {}) {
  const { rows } = await client.query(
    `SELECT id, internet_message_id, conversation_id, raw, action FROM email_thread_mapping WHERE id = $1 FOR UPDATE`,
    [mappingId]
  )
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  const m = rows[0]
  if (m.action === 'skipped_other') return false // déjà ignoré
  if (m.action !== 'pending_review') throw new Error('NOT_PENDING')

  const ids = [m.id]
  if (wholeThread) {
    const siblings = await findThreadSiblings(client, m)
    for (const s of siblings) if (s.action === 'pending_review') ids.push(s.id)
  }
  await client.query(
    `UPDATE email_thread_mapping SET action = 'skipped_other', processed_at = now() WHERE id = ANY($1::uuid[])`,
    [ids]
  )
  return true
}

// Corps complet d'un mail en attente, à la demande (lecture avant tri).
// Retourne { body_text, source: 'graph' | 'preview' }.
export async function readMappingBody(db, log, mappingId) {
  const { rows } = await db.query(
    `SELECT id, mailbox, graph_message_id, subject, raw FROM email_thread_mapping WHERE id = $1`, [mappingId]
  )
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  const m = rows[0]
  const g = m.raw || {}
  const keepQuoted = isForwardedSubject(m.subject || g.subject)
  try {
    if (m.mailbox && m.graph_message_id) {
      const full = await getMessage(m.mailbox, m.graph_message_id)
      const text = stripNul(extractMailBodyText(g, full, { keepQuoted, maxChars: 20000 }))
      if (text) return { body_text: text, source: 'graph' }
    }
  } catch (err) {
    log?.warn({ err: err.message, mappingId }, 'inbox: lecture du corps complet échouée, fallback preview')
  }
  return { body_text: stripNul(htmlToText(g.bodyPreview || '')), source: 'preview' }
}
