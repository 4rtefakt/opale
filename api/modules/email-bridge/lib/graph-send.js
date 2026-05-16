// Envoi d'un mail via Microsoft Graph (Phase 4, issue #8).
//
// Endpoint : POST /users/{sender}/sendMail. Le corps `message` accepte des
// headers RFC custom via `internetMessageHeaders`. ATTENTION : ces headers
// doivent être préfixés `x-` selon la doc Graph officielle... SAUF que
// In-Reply-To et References sont des exceptions documentées : Graph les
// accepte tels quels et les pose sur le mail sortant. C'est ce qui rend ce
// scénario faisable côté API ; sans cette exception, le threading serait
// impossible en app-only.
//
// Le corps du mail est en HTML brut (text → HTML basique). On garde simple :
// pas de templating, pas de signature ajoutée — le maintainer écrit ce qu'il
// veut envoyer.

import { getAppToken } from '../../core/lib/graph.js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function encodeMailbox(addr) { return encodeURIComponent(String(addr).trim()) }

// Échappe le texte utilisateur avant injection HTML.
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Transforme un message texte (newlines, paragraphes) en HTML lisible.
// Volontairement minimaliste : un <p> par paragraphe, <br> pour les
// retours de ligne intra-paragraphe.
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// Envoie un mail. `sender` = adresse de la boîte (boutin@..., helpdesk@...),
// `to` = destinataire unique pour l'instant (les tickets ont un seul
// requester ; on étend plus tard si besoin de CC).
//
// `headers` = { inReplyTo, references } — strings prêtes pour les headers
// RFC, peuvent être null.
export async function sendMail({
  sender, to, subject, bodyText,
  inReplyTo = null, references = null,
  fetchImpl = fetch,
} = {}) {
  if (!sender) throw new Error('sendMail: sender manquant')
  if (!to)     throw new Error('sendMail: to manquant')

  const internetMessageHeaders = []
  if (inReplyTo)  internetMessageHeaders.push({ name: 'In-Reply-To', value: inReplyTo })
  if (references) internetMessageHeaders.push({ name: 'References',  value: references })

  const message = {
    subject: subject || '(sans sujet)',
    body: { contentType: 'HTML', content: textToHtml(bodyText) },
    toRecipients: [{ emailAddress: { address: to } }],
  }
  if (internetMessageHeaders.length) message.internetMessageHeaders = internetMessageHeaders

  const token = await getAppToken()
  const res = await fetchImpl(`${GRAPH_BASE}/users/${encodeMailbox(sender)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // saveToSentItems=true : la boîte expéditrice voit le mail dans ses
    // "Éléments envoyés". Important côté maintainer pour audit/recouvrement.
    body: JSON.stringify({ message, saveToSentItems: true }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const snippet = body ? ` — ${body.slice(0, 300)}` : ''
    const hint =
      res.status === 401 ? ' (token invalide ?)' :
      res.status === 403 ? ' (perm Mail.Send consentie ?)' :
      res.status === 404 ? ' (mailbox sender inconnue ?)' :
      ''
    throw new Error(`Graph sendMail: ${res.status}${hint}${snippet}`)
  }

  // sendMail retourne 202 Accepted sans body. Microsoft génère le
  // Message-ID final côté serveur, on ne peut pas le contrôler. Pas grave
  // pour le matching des réponses futures : Outlook côté destinataire
  // conserve la `conversationId` ET inclut notre `References` dans la
  // chaîne de sa propre réponse → le worker inbound matche via
  // conversationId OU via un Message-ID inbound présent dans References.
  return { ok: true, status: res.status }
}
