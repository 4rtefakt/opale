// Matching d'un mail entrant à un ticket existant (Phase 2, issue #8).
//
// Ordre de fiabilité décroissante :
//   1. In-Reply-To : Message-ID du parent direct → lookup dans
//      email_thread_mapping. Si trouvé ET ticket_id présent → match.
//   2. References : chaîne du thread. On scanne du plus récent au plus
//      ancien (Outlook met les références dans l'ordre chronologique).
//   3. conversationId Graph : groupe Outlook natif, identique pour tous
//      les mails d'un même thread.
//   4. Tag sujet [Opale #NNN] : fallback robuste — Phase 4 quand on aura
//      arrêté un format pour NNN. POUR L'INSTANT, le tag n'est pas branché
//      (on retourne null si seul le tag est présent). Le parser le capture
//      mais on n'a pas encore d'ID lisible sur les tickets.
//
// Retourne le ticket_id (UUID) du premier match trouvé, ou null.
//
// Note : on cherche aussi via proposal_id pour gérer le cas "réponse à un
// mail dont la proposition n'est pas encore acceptée" — la proposition a
// `ticket_id` NULL tant qu'elle n'est pas acceptée. Dans ce cas on retourne
// `{ proposal_id }` à la place, et le caller décide quoi faire (en pratique :
// append à la même proposition via source_payload, ou créer une nouvelle).

import { extractMatchingHints } from './header-parser.js'

// Helper : depuis une liste de Message-IDs, retourne le premier qui a un
// ticket_id non-NULL dans email_thread_mapping.
async function findTicketByMessageIds(db, messageIds) {
  if (!messageIds.length) return null
  const { rows } = await db.query(
    `SELECT internet_message_id, ticket_id, proposal_id
     FROM email_thread_mapping
     WHERE internet_message_id = ANY($1)
       AND (ticket_id IS NOT NULL OR proposal_id IS NOT NULL)`,
    [messageIds]
  )
  if (!rows.length) return null

  // Préserver l'ordre des messageIds (In-Reply-To en premier = plus pertinent).
  const byId = new Map(rows.map(r => [r.internet_message_id, r]))
  for (const id of messageIds) {
    const r = byId.get(id)
    if (r) return { ticket_id: r.ticket_id, proposal_id: r.proposal_id, via: 'message-id' }
  }
  return null
}

async function findTicketByConversationId(db, conversationId) {
  if (!conversationId) return null
  const { rows } = await db.query(
    `SELECT ticket_id, proposal_id
     FROM email_thread_mapping
     WHERE conversation_id = $1
       AND (ticket_id IS NOT NULL OR proposal_id IS NOT NULL)
     ORDER BY received_at DESC NULLS LAST
     LIMIT 1`,
    [conversationId]
  )
  if (!rows.length) return null
  return { ticket_id: rows[0].ticket_id, proposal_id: rows[0].proposal_id, via: 'conversation-id' }
}

// Surface publique : prend les headers parsés et tente le match.
// Retourne { ticket_id?, proposal_id?, via } ou null.
//
// Important : on retourne ticket_id en priorité sur proposal_id quand les
// deux sont présents (ticket = acceptation effective, proposal = en attente).
export async function matchThread(db, { inReplyToHeader, referencesHeader, conversationId, subject } = {}) {
  const hints = extractMatchingHints({
    inReplyTo:  inReplyToHeader,
    references: referencesHeader,
    subject,
  })

  // Liste ordonnée : In-Reply-To d'abord (le parent direct, le plus
  // pertinent), puis References (parcours du fil) — déduplication implicite
  // côté DB via le ANY.
  const candidateIds = [...hints.inReplyTo, ...hints.references]
  const byMsgId = await findTicketByMessageIds(db, candidateIds)
  if (byMsgId) return byMsgId

  const byConv = await findTicketByConversationId(db, conversationId)
  if (byConv) return byConv

  // Phase 4 : matching par tag sujet [Opale #NNN] arrivera ici, quand on
  // aura un format d'ID lisible côté ticket. Pour l'instant, no-op : on
  // capture le tag dans le parser mais on ne fait rien avec.
  return null
}
