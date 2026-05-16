// Wrapper minimal autour de Microsoft Graph pour la lecture des mails.
//
// Phase 1 : lecture seulement. Mail.Send et la réponse arriveront en Phase 4.
// On réutilise getAppToken() de core/lib/graph.js — même app registration,
// scope étendu via les permissions applicatives Mail.Read sur la même app.
//
// Auth model : app-only (client credentials). Pas de delegated, pas d'OAuth
// utilisateur, pas de refresh token à stocker. Conséquence : la perm
// Mail.Read est large (toute la mailbox de la cible) — l'isolation se fait
// au niveau application registration, pas au niveau utilisateur.

import { getAppToken } from '../../core/lib/graph.js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

// Encodage URI safe pour une adresse mail en tant que segment de path Graph.
// Graph accepte l'email tel quel dans /users/{address} mais on encode pour
// éviter les surprises sur des aliases atypiques ou caractères réservés.
function encodeMailbox(addr) {
  return encodeURIComponent(String(addr).trim())
}

// GET avec auth + gestion 401/403/404 explicites pour logger des messages
// actionnables côté ops (ex: "permission manquante" vs "boîte n'existe pas").
async function graphGet(path) {
  const token = await getAppToken()
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const snippet = body ? ` — ${body.slice(0, 200)}` : ''
    const hint =
      res.status === 401 ? ' (token invalide ?)' :
      res.status === 403 ? ' (perm Mail.Read consentie sur cette app ?)' :
      res.status === 404 ? ' (mailbox inconnue / mal écrite ?)' :
      ''
    throw new Error(`Graph ${path}: ${res.status}${hint}${snippet}`)
  }
  return res.json()
}

// Liste les mails reçus depuis `sinceIso` (exclusif) dans la boîte cible.
//
// Champs sélectionnés : juste ce qu'il faut pour la classif Phase 2 + le
// matching Phase 4. On évite `body` pour limiter la bande passante au polling
// — on le re-fetch au moment de classifier (Phase 2) si vraiment nécessaire.
// En pratique, `bodyPreview` (premiers 255 chars) suffit pour 95 % des cas.
//
// $orderby=receivedDateTime asc : on lit dans l'ordre, pour pouvoir avancer
// le curseur progressivement même si on s'arrête en cours de page.
//
// Pagination : on retourne la page brute Graph (`@odata.nextLink` inclus).
// Le worker décide s'il pagine ou s'il garde la suite pour le prochain tick.
export async function listMessagesSince(mailbox, sinceIso, { top = 50 } = {}) {
  const select = [
    'id',
    'internetMessageId',
    'conversationId',
    'subject',
    'bodyPreview',
    'from',
    'toRecipients',
    'receivedDateTime',
    'hasAttachments',
    'internetMessageHeaders',
  ].join(',')

  // $filter sur receivedDateTime avec un timestamp ISO. Graph veut le `Z` final.
  // Si sinceIso est nul, on retourne les N plus récents (init premier run).
  const filter = sinceIso
    ? `receivedDateTime gt ${encodeURIComponent(sinceIso)}`
    : null

  const params = new URLSearchParams()
  params.set('$top', String(Math.min(Math.max(top, 1), 100)))
  params.set('$orderby', 'receivedDateTime asc')
  params.set('$select', select)
  if (filter) params.set('$filter', filter)

  const path = `/users/${encodeMailbox(mailbox)}/mailFolders/inbox/messages?${params.toString()}`
  return graphGet(path)
}

// Re-fetch un message complet (corps + headers complets) — utilisé Phase 2/3
// quand on a besoin du body pour la classification ou des PJ. Pas utilisé
// par le worker Phase 1, exporté pour stabiliser l'API du module dès maintenant.
export async function getMessage(mailbox, graphMessageId) {
  return graphGet(`/users/${encodeMailbox(mailbox)}/messages/${encodeURIComponent(graphMessageId)}`)
}
