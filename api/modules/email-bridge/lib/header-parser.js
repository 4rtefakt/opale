// Parsing des headers RFC 5322 pertinents pour le pont mail ↔ tickets.
//
// Trois primitives :
//   - parseMessageIdList : extrait la liste des Message-IDs d'un header
//     In-Reply-To ou References. Tolère espace, virgule, retour-chariot.
//   - extractTicketTag   : extrait l'identifiant "[Opale #NNN]" d'un subject.
//     Le format réel du NNN (numérique, slug, UUID raccourci) est décidé
//     en Phase 3/4 ; le parser retourne la chaîne brute capturée.
//   - normalizeMessageId : trim + ajoute les chevrons < > manquants.
//     Graph/Exchange renvoient parfois "abc@host", parfois "<abc@host>" —
//     on normalise pour pouvoir comparer/lookup en DB sans ambiguïté.
//
// Aucune dépendance externe : ces fonctions tournent en pur JS et sont
// testées exhaustivement (cas critiques, faciles à régresser).

// Capture tout token qui ressemble à un Message-ID : <local@domain>.
// Le contenu entre chevrons est laxiste (RFC 5322 autorise quoted-string,
// dot-atom, etc.) — on accepte tout sauf < et >.
const MESSAGE_ID_RE = /<([^<>]+)>/g

// Tag sujet : "[Opale #NNN]" insensible à la casse, espaces tolérés.
// Le groupe capturant est volontairement laxiste (alphanumérique + tiret)
// pour absorber plusieurs schémas d'ID (numérique, slug, UUID court).
const TICKET_TAG_RE = /\[\s*Opale\s*#\s*([A-Za-z0-9-]+)\s*\]/i

export function normalizeMessageId(id) {
  if (id == null) return null
  const s = String(id).trim()
  if (!s) return null
  if (s.startsWith('<') && s.endsWith('>')) return s
  return `<${s}>`
}

// Parse un header In-Reply-To ou References et retourne une liste ordonnée
// de Message-IDs normalisés. Dédupliqué (premier-vu gagne) pour matcher
// l'usage côté caller : "essaie chaque ID, le plus récent en tête".
//
// Cas couverts :
//   - header absent / vide / null → []
//   - un seul ID : "<a@b>"
//   - plusieurs IDs séparés par espaces (le cas standard pour References)
//   - séparation par CRLF / tab (clients mail tolérants)
//   - ID sans chevrons (Exchange parfois) — accepté en fallback si aucun
//     chevron n'est trouvé du tout dans la chaîne
//   - tokens parasites (texte hors chevrons) ignorés
export function parseMessageIdList(header) {
  if (header == null) return []
  const s = String(header).trim()
  if (!s) return []

  const ids = []
  const seen = new Set()
  let m
  MESSAGE_ID_RE.lastIndex = 0
  while ((m = MESSAGE_ID_RE.exec(s)) !== null) {
    const id = `<${m[1].trim()}>`
    if (id.length > 2 && !seen.has(id)) { seen.add(id); ids.push(id) }
  }

  // Fallback : aucun chevron trouvé → on tente de traiter la chaîne entière
  // comme un seul Message-ID nu (cas Exchange tolérant). On ne fait PAS de
  // split sur espace ici : un Message-ID peut légitimement contenir des
  // caractères atypiques. Si plusieurs IDs sont attendus, ils auront leurs
  // chevrons (sinon ils sont indissociables).
  if (!ids.length && !s.includes('<') && !s.includes('>')) {
    const single = normalizeMessageId(s)
    if (single) ids.push(single)
  }

  return ids
}

// Extrait l'identifiant ticket d'un subject. Retourne la chaîne capturée
// (sans crochets / sans #), ou null si pas de tag.
export function extractTicketTag(subject) {
  if (subject == null) return null
  const m = TICKET_TAG_RE.exec(String(subject))
  return m ? m[1] : null
}

// Sucre : retourne TOUS les identifiants candidats pour matcher un mail
// entrant à un ticket existant, du plus fiable au moins fiable :
//   1. In-Reply-To (le mail parent direct — méthode propre)
//   2. References parsés (chaîne complète du thread)
//   3. Tag sujet [Opale #NNN] (fallback si le client casse le threading)
//
// Le caller décide quoi faire de cette liste (lookup DB, fuzzy match, etc.).
// On ne dédup pas across-source : un même ID peut apparaître dans In-Reply-To
// ET References — c'est la même info, le caller peut s'en accommoder.
export function extractMatchingHints({ inReplyTo, references, subject } = {}) {
  return {
    inReplyTo:   parseMessageIdList(inReplyTo),
    references:  parseMessageIdList(references),
    ticketTag:   extractTicketTag(subject),
  }
}
