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
//
// Deux temps, pour ne tenir ni verrou ni connexion pendant les appels Graph
// (jusqu'à ~20 corps de mails, chacun quelques centaines de ms) :
//   1. prepareThread(db)     — hors transaction : fil DB, mails Graph
//      manquants, corps complets (en parallèle). Aucune écriture.
//   2. createTicketFromMapping / attachMappingToTicket(client, …, prepared)
//      — dans la transaction, fil DB relu et verrouillé (FOR UPDATE), corps
//      déjà chargés réutilisés, seul ce qui a changé entre-temps est refait.

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
export async function findThreadSiblings(db, m, { forUpdate = false } = {}) {
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
    ${forUpdate ? 'FOR UPDATE' : ''}
  `, [m.id, m.conversation_id || null, refIds, ownIds.map(id => String(id).replace(/^<|>$/g, ''))])
  return rows
}

// Parmi des mails Graph, ceux qui ne sont ni dans `knownIds` ni déjà en
// base — une seule requête quelle que soit la taille de la page.
async function unknownGraphMessages(db, graphMessages, knownIds) {
  const cand = (graphMessages || []).filter(g => g?.internetMessageId
    && !knownIds.has(storedMessageId(g.internetMessageId)) && !knownIds.has(g.internetMessageId))
  if (!cand.length) return []
  const keys = [...new Set(cand.flatMap(g => messageIdLookupKeys(g.internetMessageId)))]
  const { rows } = await db.query(
    `SELECT internet_message_id FROM email_thread_mapping WHERE internet_message_id = ANY($1::text[])`, [keys]
  )
  const inDb = new Set(rows.map(r => r.internet_message_id))
  return cand.filter(g => !messageIdLookupKeys(g.internetMessageId).some(k => inDb.has(k)))
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
  const fresh = await unknownGraphMessages(db, page.value, knownIds)
  return fresh.slice(0, GRAPH_THREAD_MAX).map(g => {
    const fromAddr = String(senderOf(g).address || '').toLowerCase()
    const direction = (page.sentFolderId && g.parentFolderId === page.sentFolderId) || (fromAddr && fromAddr === mailbox)
      ? 'outbound' : 'inbound'
    return { graphMessage: stripNul(g), direction }
  })
}

// ── Corps d'un mail ─────────────────────────────────────────────────────────

// Corps complet via Graph (best-effort), sinon bodyPreview. Toujours du
// texte propre sans NUL. `keepQuoted` pour un mail transféré : la citation
// EST l'historique qu'on veut. Retourne { body_text, source: 'graph' | 'preview' }.
async function fetchBodyText(log, { mailbox, graphMessageId, graphMessage, mappingId }, { maxChars } = {}) {
  const keepQuoted = isForwardedSubject(graphMessage?.subject)
  try {
    if (mailbox && graphMessageId) {
      const full = await getMessage(mailbox, graphMessageId)
      const text = stripNul(extractMailBodyText(graphMessage, full, { keepQuoted, maxChars }))
      if (text) return { body_text: text, source: 'graph' }
    }
  } catch (err) {
    log?.warn({ err: err.message, mappingId },
      'inbox: fetch full body échoué, fallback bodyPreview')
  }
  return { body_text: stripNul(htmlToText(graphMessage?.bodyPreview || '')), source: 'preview' }
}

// ── Assemblage du fil ───────────────────────────────────────────────────────

const MAPPING_COLS = `id, mailbox, internet_message_id, graph_message_id, conversation_id,
            direction, from_address, subject, received_at, raw, action, ticket_id, proposal_id`
const BODY_FETCH_CONCURRENCY = 4

function knownIdsOf(rows) {
  const ids = new Set()
  for (const r of rows) {
    ids.add(r.internet_message_id)
    if (r.raw?.internetMessageId) ids.add(r.raw.internetMessageId)
  }
  return ids
}

// Un item du fil = un futur message du ticket :
//   { mappingId?, graphMessage, direction, mailbox, graphMessageId,
//     fromAddress, fromName, subject, receivedAt, bodyText }
function itemOfMapping(r) {
  const g = r.raw || {}
  return {
    mappingId: r.id, graphMessage: g, direction: r.direction || 'inbound',
    mailbox: r.mailbox, graphMessageId: r.graph_message_id,
    fromAddress: r.from_address || senderOf(g).address,
    fromName: senderOf(g).name || r.from_address || 'expéditeur inconnu',
    subject: r.subject || g.subject || null,
    receivedAt: r.received_at || g.receivedDateTime || null,
  }
}
function itemOfExtra(m, e) {
  const g = e.graphMessage
  return {
    mappingId: null, graphMessage: g, direction: e.direction,
    mailbox: m.mailbox, graphMessageId: g.id,
    fromAddress: senderOf(g).address,
    fromName: senderOf(g).name || senderOf(g).address || 'expéditeur inconnu',
    subject: g.subject || null,
    receivedAt: g.receivedDateTime || g.sentDateTime || null,
  }
}
function buildItems(m, siblings, extras) {
  return [m, ...siblings].map(itemOfMapping).concat(extras.map(e => itemOfExtra(m, e)))
    .sort((a, b) => Date.parse(a.receivedAt || 0) - Date.parse(b.receivedAt || 0))
}
const bodyKey = (it) => it.mappingId ? `m:${it.mappingId}` : `g:${it.graphMessageId}`

// Corps des items, `BODY_FETCH_CONCURRENCY` appels Graph en parallèle ;
// ceux déjà présents dans `cache` (phase 1) ne sont pas rechargés.
async function fillBodies(log, items, cache) {
  const todo = []
  for (const it of items) {
    const c = cache?.get(bodyKey(it))
    if (c !== undefined) it.bodyText = c
    else todo.push(it)
  }
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++]
      const { body_text } = await fetchBodyText(log, {
        mailbox: it.mailbox, graphMessageId: it.graphMessageId,
        graphMessage: it.graphMessage, mappingId: it.mappingId,
      })
      it.bodyText = body_text
    }
  }
  await Promise.all(Array.from({ length: Math.min(BODY_FETCH_CONCURRENCY, todo.length) }, worker))
}

// Phase 1, hors transaction : fil DB + mails Graph manquants + corps.
// Retourne { mappingId, extras, bodies } à passer à la phase 2. Lève
// MAPPING_NOT_FOUND / ALREADY_LINKED comme la phase 2 (réponse rapide).
export async function prepareThread(db, log, mappingId) {
  const { rows } = await db.query(`SELECT ${MAPPING_COLS} FROM email_thread_mapping WHERE id = $1`, [mappingId])
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  const m = rows[0]
  if (m.ticket_id) throw new Error('ALREADY_LINKED')
  const siblings = await findThreadSiblings(db, m)
  const extras = await fetchMissingConversationMessages(db, log, m, knownIdsOf([m, ...siblings]))
  const items = buildItems(m, siblings, extras)
  await fillBodies(log, items)
  return { mappingId, extras, bodies: new Map(items.map(it => [bodyKey(it), it.bodyText])) }
}

// Phase 2, dans la transaction (`m` verrouillé par lockMapping) : le fil DB
// est relu et verrouillé — c'est lui qui fait foi, un mail absorbé entre-temps
// par un autre admin n'y figure plus. Sans `prepared`, tout est fait ici.
async function assembleThread(client, log, m, prepared = null) {
  const siblings = await findThreadSiblings(client, m, { forUpdate: true })
  const knownIds = knownIdsOf([m, ...siblings])
  let extras
  if (prepared && prepared.mappingId === m.id) {
    const still = new Set(await unknownGraphMessages(client, prepared.extras.map(e => e.graphMessage), knownIds))
    extras = prepared.extras.filter(e => still.has(e.graphMessage))
  } else {
    extras = await fetchMissingConversationMessages(client, log, m, knownIds)
  }
  const items = buildItems(m, siblings, extras)
  await fillBodies(log, items, prepared?.bodies)
  return items
}

// Verse les items dans le ticket : mappings (repointés ou créés) puis
// messages. Le mapping d'abord, conditionnel : un mail rattaché entre-temps
// par une autre transaction (ticket_id déjà posé, ou ligne déjà créée) n'est
// pas versé une seconde fois.
async function appendThreadToTicket(client, ticketId, items) {
  let appended = 0
  for (const it of items) {
    if (it.mappingId) {
      const { rowCount } = await client.query(
        `UPDATE email_thread_mapping
         SET ticket_id = $1, action = 'message_appended', processed_at = now(), error_message = NULL
         WHERE id = $2 AND ticket_id IS NULL`,
        [ticketId, it.mappingId]
      )
      if (!rowCount) continue
    } else {
      const g = it.graphMessage
      const { rows } = await client.query(`
        INSERT INTO email_thread_mapping
          (internet_message_id, conversation_id, graph_message_id, mailbox, direction,
           from_address, subject, received_at, raw, processed_at, action, ticket_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), 'message_appended', $10)
        ON CONFLICT (internet_message_id) DO NOTHING
        RETURNING id
      `, [
        storedMessageId(g.internetMessageId), g.conversationId || null, g.id || null,
        it.mailbox, it.direction, it.fromAddress, it.subject, it.receivedAt || null,
        JSON.stringify(g), ticketId,
      ])
      if (!rows.length) continue
    }
    // email_sent_at = now() : ce message vient déjà d'un mail, l'outbox ne
    // doit pas le renvoyer. created_at = date du mail → ordre chronologique.
    await client.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
      VALUES ($1, 'comment', $2, $3, now(), COALESCE($4::timestamptz, now()))
    `, [ticketId, it.fromName, it.bodyText || '(corps vide)', it.receivedAt || null])
    appended++
  }
  await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticketId])
  return appended
}

// Expéditeurs externes du fil (hors boîte de réception) reconnus comme
// utilisateurs Opale, dédoublonnés, dans l'ordre chronologique, chacun avec
// son `address`.
async function matchThreadSenders(client, items, mailbox) {
  const box = String(mailbox || '').toLowerCase()
  const seen = new Set()
  const matched = []
  for (const it of items) {
    const addr = String(it.fromAddress || '').toLowerCase()
    if (!addr || addr === box || seen.has(addr) || it.direction === 'outbound') continue
    seen.add(addr)
    const s = await matchSender(client, addr).catch(() => ({}))
    if (s.user_id) matched.push({ ...s, address: addr })
  }
  return matched
}

async function lockMapping(client, mappingId) {
  const { rows } = await client.query(
    `SELECT ${MAPPING_COLS} FROM email_thread_mapping WHERE id = $1 FOR UPDATE`,
    [mappingId]
  )
  if (!rows.length) throw new Error('MAPPING_NOT_FOUND')
  if (rows[0].ticket_id) throw new Error('ALREADY_LINKED')
  return rows[0]
}

// Crée un ticket à partir d'un mapping en attente de tri, avec tout son fil.
// `prepared` : résultat de prepareThread (phase 1) ; sans lui, les appels
// Graph ont lieu ici. Retourne l'objet ticket créé, enrichi de
// `absorbed_count` (nombre de mails versés dans le ticket, celui-ci compris).
// Demandeur : l'expéditeur du mail converti s'il est un utilisateur connu
// (c'est lui que la page de tri annonce), sinon le premier expéditeur connu
// du fil ; les autres sont « concernés ».
export async function createTicketFromMapping(client, log, { mappingId, byEntraId, byName, prepared = null }) {
  const m = await lockMapping(client, mappingId)
  const items = await assembleThread(client, log, m, prepared)

  const senders = await matchThreadSenders(client, items, m.mailbox)
  const clickedAddr = String(m.from_address || '').toLowerCase()
  const requester = senders.find(s => s.address === clickedAddr) || senders[0] || {}

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
  for (const s of senders) if (s !== requester) await addInvolvedUser(client, tk.id, s.user_id)

  tk.absorbed_count = appended
  return tk
}

// Rattache un mail en attente (et son fil) à un ticket EXISTANT : le mail
// était en réalité la suite d'une demande déjà ouverte.
// Retourne { ticket_id, appended }.
export async function attachMappingToTicket(client, log, { mappingId, ticketId, prepared = null }) {
  const m = await lockMapping(client, mappingId)
  const { rows: tRows } = await client.query(
    `SELECT id, status, merged_into FROM tickets WHERE id = $1 FOR UPDATE`, [ticketId]
  )
  if (!tRows.length) throw new Error('TICKET_NOT_FOUND')
  if (tRows[0].status === 'merged') throw new Error('TICKET_MERGED')

  const items = await assembleThread(client, log, m, prepared)
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
    const siblings = await findThreadSiblings(client, m, { forUpdate: true })
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
  const g = { ...(m.raw || {}), subject: m.subject || m.raw?.subject }
  return fetchBodyText(log, { mailbox: m.mailbox, graphMessageId: m.graph_message_id, graphMessage: g, mappingId: m.id },
    { maxChars: 20000 })
}
