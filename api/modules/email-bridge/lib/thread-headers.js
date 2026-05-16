// Construction des headers de threading pour un mail sortant (Phase 4).
//
// Objectif : qu'Outlook côté destinataire affiche le mail dans le bon thread,
// même après plusieurs aller-retours, et MÊME si le client mail casse le
// `[Opale #...]` du subject.
//
// Règles RFC 5322 :
//   - `In-Reply-To` = Message-ID du message auquel on répond (le parent direct,
//     en pratique le dernier mail inbound du thread).
//   - `References`  = chaîne historique des Message-ID du thread, du plus
//     ancien au plus récent. Outlook s'en sert pour reconstruire l'arbre
//     même si In-Reply-To pointe vers un message disparu.
//
// On reconstitue cette chaîne depuis `email_thread_mapping` filtré sur
// le ticket : tous les mails (inbound + outbound) du même thread Opale,
// triés par received_at.

import { normalizeMessageId } from './header-parser.js'

// Identifiant lisible pour le subject tag [Opale #NNN].
//
// Les tickets ont un UUID — pas un sequence numérique. On extrait les 8
// premiers chars en majuscules : suffisamment court pour rester lisible
// dans un subject, suffisamment unique pour qu'une collision soit
// improbable (2^32 valeurs possibles, on en aura quelques milliers).
//
// Quand le matching récupère ce tag (parser Phase 1 → extractTicketTag),
// le caller peut chercher `WHERE id::text ILIKE '<tag>%'` pour retrouver
// le ticket. Collision théorique = 2 tickets dont l'UUID commence pareil,
// résolu côté matching en prenant le plus récent du thread.
export function ticketTagFromUuid(uuid) {
  if (!uuid) return null
  return String(uuid).replace(/-/g, '').slice(0, 8).toUpperCase()
}

// Construit le subject avec le tag injecté juste avant l'objet. Idempotent :
// si le subject contient déjà un tag (cas d'une réponse), on ne dédouble pas.
export function buildSubject(originalSubject, ticketUuid) {
  const tag = ticketTagFromUuid(ticketUuid)
  if (!tag) return originalSubject || '(sans sujet)'

  // Le subject original peut être null (nouveau thread) ou déjà préfixé
  // d'un tag (réponse). Strip les tags existants puis on remet le bon.
  const cleaned = String(originalSubject || '')
    .replace(/\[\s*Opale\s*#\s*[A-Za-z0-9-]+\s*\]\s*/gi, '')
    .trim()

  const subject = cleaned || '(sans sujet)'
  // Préserver le préfixe Re:/TR:/Fwd: en tête, sinon coller le tag devant.
  const reMatch = subject.match(/^((?:re|tr|fwd|fw)\s*:\s*)+/i)
  if (reMatch) {
    const prefix = reMatch[0]
    return `${prefix}[Opale #${tag}] ${subject.slice(prefix.length)}`.trim()
  }
  return `[Opale #${tag}] ${subject}`
}

// Construit les headers In-Reply-To et References à partir d'une liste de
// rows email_thread_mapping (déjà triées par received_at ASC, du plus ancien
// au plus récent).
//
// Retourne { inReplyTo, references }. Les deux sont des STRINGS prêts pour
// les headers RFC, ou null si rien à inclure (premier mail d'un thread —
// très rare pour outbound puisqu'on répond toujours à quelque chose).
export function buildThreadHeaders(mappingRows) {
  if (!Array.isArray(mappingRows) || !mappingRows.length) {
    return { inReplyTo: null, references: null }
  }

  // In-Reply-To : Message-ID du dernier mail INBOUND (= celui auquel on
  // répond). Si pas d'inbound (cas pathologique), prendre le dernier tout
  // court.
  const inbound = mappingRows.filter(r => r.direction === 'inbound')
  const parent = inbound.length ? inbound[inbound.length - 1] : mappingRows[mappingRows.length - 1]
  const inReplyTo = normalizeMessageId(parent.internet_message_id)

  // References : chaîne complète, dans l'ordre chronologique (RFC veut
  // ancien → récent). Dédupliquée pour éviter qu'un même ID apparaisse
  // deux fois si on a des fragments.
  const seen = new Set()
  const refs = []
  for (const r of mappingRows) {
    const id = normalizeMessageId(r.internet_message_id)
    if (id && !seen.has(id)) { seen.add(id); refs.push(id) }
  }
  const references = refs.length ? refs.join(' ') : null

  return { inReplyTo, references }
}
