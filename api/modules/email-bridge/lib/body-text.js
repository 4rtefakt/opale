// Extraction du texte d'un mail Graph (Phase 5b, issue #8).
//
// Microsoft Graph retourne `body.content` en HTML par défaut pour les
// mails Outlook (contentType='HTML') ou en plain text si le mail a été
// envoyé en text/plain (contentType='Text'). On veut un texte propre
// pour 3 usages :
//   - `suggested_description` de ticket_proposals
//   - `content` de ticket_messages quand on append
//   - prompt du classifieur (en Phase 2 ; pour l'instant on reste sur
//     bodyPreview pour la classif — c'est suffisant)
//
// Strip de signature : heuristique simple basée sur 3 marqueurs courants.
// Volontairement défensif : en cas de doute, on garde plus de texte que
// trop peu (l'utilisateur préfère une signature résiduelle à une question
// tronquée).

// Convertit du HTML basique (mails Outlook standards) en texte. Préserve
// les retours de ligne et les paragraphes. Ne gère PAS les tables imbriquées
// ni les structures complexes — pour ça il faudrait un vrai parseur HTML.
// Cas typique d'Outlook : <p>...<br>...</p><p>...</p> — bien géré ici.
export function htmlToText(html) {
  if (!html) return ''
  return String(html)
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<li\s*>/gi, '- ')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')      // trim whitespace en fin de ligne
    .replace(/\n{3,}/g, '\n\n')      // collapse les blancs multiples
    .trim()
}

// Strip de signature. Trois patterns détectés, dans l'ordre — on coupe au
// premier qui matche. Aucun match → on retourne le texte intact.
//
// 1. Délimiteur RFC 3676 : une ligne avec exactement `-- ` (deux dashs +
//    espace). Convention standard pour séparer signature du corps.
// 2. Footers mobiles Outlook : "Envoyé depuis…", "Sent from…", etc.
// 3. Bloc cité Outlook : "De : <expéditeur>\nEnvoyé : <date>" — apparaît
//    en réponse, on garde uniquement le message du dessus.
export function stripSignature(text) {
  if (!text) return text
  let s = String(text)

  // 1. Délimiteur RFC.
  const rfcMatch = s.match(/^--\s*$/m)
  if (rfcMatch && rfcMatch.index > 5) {  // > 5 : tolère un mail court, exclut un match en tout début
    s = s.slice(0, rfcMatch.index).trimEnd()
  }

  // 2. Footer mobile / promo Outlook.
  const footerMatch = s.match(/^(Envoyé\s+depuis|Sent\s+from|Get\s+Outlook\s+for|Téléchargez\s+Outlook|Obtenez\s+Outlook).+$/im)
  if (footerMatch && footerMatch.index > 5) {
    s = s.slice(0, footerMatch.index).trimEnd()
  }

  // 3. Bloc cité Outlook (forwarded / réponse).
  const quotedMatch = s.match(/^(De|From)\s*:\s.+\r?\n.*(Envoyé|Sent)\s*:/m)
  if (quotedMatch && quotedMatch.index > 5) {
    s = s.slice(0, quotedMatch.index).trimEnd()
  }

  return s.trim()
}

// Extrait le texte d'affichage final d'un mail Graph. `fullMessage` est le
// résultat de getMessage() (avec body.content). Si absent, on retombe sur
// le bodyPreview du `graphMessage` initial.
//
// Limite la sortie à `maxChars` pour éviter qu'un mail de 50 pages
// remplisse une description de ticket. Par défaut 8000 chars (très large,
// permet de garder un long signalement détaillé).
export function extractMailBodyText(graphMessage, fullMessage, { maxChars = 8000 } = {}) {
  let body = ''
  if (fullMessage?.body?.content) {
    body = fullMessage.body.contentType === 'HTML'
      ? htmlToText(fullMessage.body.content)
      : String(fullMessage.body.content)
  } else if (graphMessage?.bodyPreview) {
    body = String(graphMessage.bodyPreview)
  }
  body = stripSignature(body)
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…(tronqué)'
  return body
}
