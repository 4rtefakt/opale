// Envoi d'un mail via Microsoft Graph (issue #8).
//
// Deux modes :
//
//   1. sendReply() — RÉPONSE THREADÉE (mode normal). Graph crée un brouillon
//      via POST /messages/{id}/createReply : il pose lui-même In-Reply-To,
//      References et conversationId corrects, hérite du destinataire et du
//      sujet "RE: …". On PATCH ensuite le corps puis on /send. C'est la SEULE
//      façon fiable de répondre dans un fil en app-only.
//
//   2. sendMail() — ENVOI SIMPLE (fallback). Quand on n'a pas le message
//      Graph d'origine (vieux mapping sans graph_message_id), on envoie un
//      mail neuf. On NE pose PAS In-Reply-To/References : contrairement à ce
//      qu'affirmait un ancien commentaire, Graph REJETTE ces headers via
//      internetMessageHeaders (400 InvalidInternetMessageHeader — ils ne
//      sont pas préfixés x-). Le mail part donc sans threading natif.
//
// Le corps du mail est en HTML basique (text → HTML). Pas de templating ni
// de signature ajoutée.

import { getAppToken } from '../../core/lib/graph.js'
import { graphFetch } from '../../core/lib/graph-fetch.js'

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
  fetchImpl = fetch,
} = {}) {
  if (!sender) throw new Error('sendMail: sender manquant')
  if (!to)     throw new Error('sendMail: to manquant')

  // Pas de In-Reply-To/References : Graph les rejette via
  // internetMessageHeaders. Le threading natif passe par sendReply().
  const message = {
    subject: subject || '(sans sujet)',
    body: { contentType: 'HTML', content: textToHtml(bodyText) },
    toRecipients: [{ emailAddress: { address: to } }],
  }

  const token = await getAppToken()
  const res = await graphFetch(`${GRAPH_BASE}/users/${encodeMailbox(sender)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // saveToSentItems=true : la boîte expéditrice voit le mail dans ses
    // "Éléments envoyés". Important côté maintainer pour audit/recouvrement.
    body: JSON.stringify({ message, saveToSentItems: true }),
  }, { fetchImpl })

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

// Répond à un mail existant dans un fil, de façon NATIVEMENT threadée.
// `mailbox` = boîte qui détient le message d'origine (celle qui l'a reçu).
// `graphMessageId` = id Graph de ce message (email_thread_mapping.graph_message_id).
//
// Séquence Graph : createReply (draft threadé) → PATCH body → send. Graph
// gère In-Reply-To / References / conversationId / destinataire / sujet
// "RE: …" tout seul. Le PATCH remplace le corps du draft par notre texte
// (on n'inclut pas la citation de l'original — réponse de support concise).
export async function sendReply({
  mailbox, graphMessageId, bodyText, fetchImpl = fetch, getToken = getAppToken,
} = {}) {
  if (!mailbox)        throw new Error('sendReply: mailbox manquant')
  if (!graphMessageId) throw new Error('sendReply: graphMessageId manquant')

  const token = await getToken()
  const base = `${GRAPH_BASE}/users/${encodeMailbox(mailbox)}`
  const authJson = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const fail = async (res, step) => {
    const body = await res.text().catch(() => '')
    const snippet = body ? ` — ${body.slice(0, 300)}` : ''
    throw new Error(`Graph sendReply/${step}: ${res.status}${snippet}`)
  }

  // 1. Brouillon de réponse threadé. Graph pré-remplit son body avec la
  // citation du fil ("De: … Envoyé: … <message d'origine>") — on la garde.
  const createRes = await graphFetch(
    `${base}/messages/${encodeURIComponent(graphMessageId)}/createReply`,
    { method: 'POST', headers: authJson, body: '{}' },
    { fetchImpl }
  )
  if (!createRes.ok) return fail(createRes, 'createReply')
  const draft = await createRes.json()
  if (!draft?.id) throw new Error('sendReply: createReply sans id de brouillon')

  // 2. Préfixe notre réponse AU-DESSUS de la citation héritée du brouillon
  // (comportement "Répondre" standard : nouveau texte en haut, fil cité en
  // dessous). Sans ça le destinataire reçoit un message threadé mais vide
  // de contexte. Si Graph n'a pas renvoyé de body (cas rare), on n'a que
  // notre texte.
  const quoted = draft.body?.content || ''
  const content = quoted ? `${textToHtml(bodyText)}<br>${quoted}` : textToHtml(bodyText)
  const patchRes = await graphFetch(
    `${base}/messages/${encodeURIComponent(draft.id)}`,
    {
      method: 'PATCH', headers: authJson,
      body: JSON.stringify({ body: { contentType: 'HTML', content } }),
    },
    { fetchImpl }
  )
  if (!patchRes.ok) return fail(patchRes, 'patch')

  // 3. Envoi du brouillon.
  const sendRes = await graphFetch(
    `${base}/messages/${encodeURIComponent(draft.id)}/send`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    { fetchImpl }
  )
  if (!sendRes.ok) return fail(sendRes, 'send')

  return { ok: true }
}
