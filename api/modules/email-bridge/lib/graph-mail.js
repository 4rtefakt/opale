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
import { graphFetch } from '../../core/lib/graph-fetch.js'

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
  const res = await graphFetch(`${GRAPH_BASE}${path}`, {
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

// Construit le path Graph pour lister les messages reçus depuis `sinceIso`.
// Exporté pour testabilité : c'est là que se cache le bug subtil (double
// URL-encoding) qui a cassé la première mise en prod.
//
// On scanne `/users/{mailbox}/messages` (TOUTE la boîte) au lieu de
// `/mailFolders/inbox/messages` : sinon les mails déplacés par les règles
// Outlook vers des sous-dossiers ne seraient jamais ingérés. Les dossiers
// système (Sent/Drafts/Deleted/Junk) sont filtrés au niveau applicatif via
// `parentFolderId` (cf. listMessagesSince + getSystemFolderIds).
//
// $orderby=receivedDateTime asc : on lit dans l'ordre, pour pouvoir avancer
// le curseur progressivement même si on s'arrête en cours de page.
//
// ATTENTION pour `$filter` : ne PAS pré-encoder `sinceIso`. URLSearchParams
// encode déjà la query string entière — double-encoder transforme `:` en
// `%253A` et Graph renvoie 400 "Invalid filter clause: Syntax error at
// position 27". Bug observé en prod le 2026-05-16, fixé ici, testé en
// regression dans email-graph-mail.test.js.
//
// `inclusive` : `ge` au lieu de `gt`. Utilisé par le worker, qui écarte
// lui-même les mails déjà traités au même horodatage que son curseur (cf.
// poll-cursor.js) : un `gt` sautait ceux qui partagent cet horodatage
// (coupure de page, mail visible un peu plus tard).
export function buildListMessagesPath(mailbox, sinceIso, { top = 50, inclusive = false } = {}) {
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
    // Champs ajoutés pour pouvoir filtrer côté app les dossiers système :
    'parentFolderId',
    'isDraft',
  ].join(',')

  const params = new URLSearchParams()
  params.set('$top', String(Math.min(Math.max(top, 1), 100)))
  params.set('$orderby', 'receivedDateTime asc')
  params.set('$select', select)
  if (sinceIso) params.set('$filter', `receivedDateTime ${inclusive ? 'ge' : 'gt'} ${sinceIso}`)

  return `/users/${encodeMailbox(mailbox)}/messages?${params.toString()}`
}

// Cache des IDs de dossiers système à exclure (Sent/Drafts/Deleted/Junk/
// Outbox). Ces IDs varient par mailbox mais sont stables dans le temps —
// TTL 1 h amplement suffisant. On les récupère via les "well-known names"
// Graph qui servent de raccourcis indépendants de la locale.
const SYSTEM_FOLDER_SHORTCUTS = ['sentitems', 'drafts', 'deleteditems', 'junkemail', 'outbox']
const FOLDER_CACHE_TTL_MS = 60 * 60 * 1000
const _systemFolderCache = new Map()  // mailbox → { ids: Set, fetchedAt }

export async function getSystemFolderIds(mailbox, { now = Date.now } = {}) {
  const cached = _systemFolderCache.get(mailbox)
  if (cached && (now() - cached.fetchedAt) < FOLDER_CACHE_TTL_MS) return cached.ids

  const ids = new Set()
  for (const shortcut of SYSTEM_FOLDER_SHORTCUTS) {
    try {
      const folder = await graphGet(`/users/${encodeMailbox(mailbox)}/mailFolders/${shortcut}`)
      if (folder?.id) ids.add(folder.id)
    } catch {
      // Dossier absent ou perm refusée → on tolère et on continue.
      // Cas typique : `outbox` n'existe pas dans certaines configurations.
    }
  }
  _systemFolderCache.set(mailbox, { ids, fetchedAt: now() })
  return ids
}

// Pour les tests : forcer le re-fetch du cache.
export function _resetSystemFolderCache() { _systemFolderCache.clear() }

// Page suivante d'un listing : `@odata.nextLink` est une URL absolue. On
// n'y envoie le jeton applicatif que si elle pointe bien sur Graph v1.0.
function nextLinkPath(nextLink) {
  const url = String(nextLink)
  if (!url.startsWith(`${GRAPH_BASE}/`)) {
    throw new Error(`Graph nextLink inattendu (hors ${GRAPH_BASE}) : ${url.slice(0, 100)}`)
  }
  return url.slice(GRAPH_BASE.length)
}

// Liste les mails reçus depuis `sinceIso` dans la boîte cible (exclusif,
// ou inclusif avec `opts.inclusive`). `opts.nextLink` : page suivante d'un
// listing précédent (`@odata.nextLink`), à la place de la première page.
// Scanne TOUS les dossiers, mais filtre les mails issus des dossiers système
// (Sent/Drafts/Deleted/Junk/Outbox) au niveau applicatif après fetch.
//
// Pagination : on retourne la page Graph (`@odata.nextLink` inclus), avec
// `value` filtré et `scanned` = tous les mails de la page, exclus compris,
// dans l'ordre Graph. Le worker avance son curseur sur `scanned` : une page
// entièrement composée de mails exclus (`value` vide) bloquait sinon le
// curseur, et donc la boîte, indéfiniment.
export async function listMessagesSince(mailbox, sinceIso, opts = {}) {
  const path = opts.nextLink
    ? nextLinkPath(opts.nextLink)
    : buildListMessagesPath(mailbox, sinceIso, opts)
  const [page, excluded] = await Promise.all([
    graphGet(path),
    getSystemFolderIds(mailbox).catch(() => new Set()),  // tolérer un échec du listing dossiers
  ])
  if (page?.value) {
    page.scanned = page.value
    page.value = page.value.filter(m =>
      !m.isDraft && !excluded.has(m.parentFolderId)
    )
  }
  return page
}

// ── Lecture du dossier "Éléments envoyés" (ingestion des réponses Outlook) ─────
//
// Contrairement à listMessagesSince (qui scanne TOUTE la boîte et EXCLUT les
// dossiers système dont sentitems), on cible ICI exclusivement /mailFolders/
// sentitems : on veut justement les mails que l'agent a envoyés depuis Outlook.
// On filtre/ordonne sur `sentDateTime` (et pas receivedDateTime, souvent absent
// sur un mail sortant). Même précaution anti double-encoding que ci-dessus :
// ne PAS pré-encoder sinceIso, URLSearchParams s'en charge.
export function buildListSentMessagesPath(mailbox, sinceIso, { top = 50 } = {}) {
  const select = [
    'id',
    'internetMessageId',
    'conversationId',
    'subject',
    'bodyPreview',
    'from',
    'toRecipients',
    'sentDateTime',
    'receivedDateTime',
    'hasAttachments',
    'internetMessageHeaders',
  ].join(',')

  const params = new URLSearchParams()
  params.set('$top', String(Math.min(Math.max(top, 1), 100)))
  params.set('$orderby', 'sentDateTime asc')
  params.set('$select', select)
  if (sinceIso) params.set('$filter', `sentDateTime gt ${sinceIso}`)

  return `/users/${encodeMailbox(mailbox)}/mailFolders/sentitems/messages?${params.toString()}`
}

// Liste les mails envoyés depuis `sinceIso` (exclusif) dans le dossier
// Éléments envoyés de la boîte cible. Retourne la page brute Graph
// (`@odata.nextLink` inclus pour la pagination côté caller).
export async function listSentMessagesSince(mailbox, sinceIso, opts = {}) {
  return graphGet(buildListSentMessagesPath(mailbox, sinceIso, opts))
}

// Re-fetch un message complet (corps + headers complets) — utilisé Phase 2/3
// quand on a besoin du body pour la classification ou des PJ. Pas utilisé
// par le worker Phase 1, exporté pour stabiliser l'API du module dès maintenant.
export async function getMessage(mailbox, graphMessageId) {
  return graphGet(`/users/${encodeMailbox(mailbox)}/messages/${encodeURIComponent(graphMessageId)}`)
}

// Marque un mail comme lu côté Outlook via PATCH /messages/{id} (Phase 5a).
// Nécessite Mail.ReadWrite (l'app n'a que Mail.Read par défaut → 403). Le
// caller doit traiter l'erreur — on ne fait pas de fallback ici, parce que
// le worker doit pouvoir distinguer "perm manquante" de "mail introuvable".
export async function markMessageAsRead(mailbox, graphMessageId, { fetchImpl = fetch } = {}) {
  if (!mailbox || !graphMessageId) {
    throw new Error('markMessageAsRead: mailbox et graphMessageId requis')
  }
  const token = await getAppToken()
  const url = `${GRAPH_BASE}/users/${encodeMailbox(mailbox)}/messages/${encodeURIComponent(graphMessageId)}`
  const res = await graphFetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  }, { fetchImpl })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const snippet = body ? ` — ${body.slice(0, 200)}` : ''
    const hint =
      res.status === 403 ? ' (perm Mail.ReadWrite consentie ?)' :
      res.status === 404 ? ' (mail supprimé/déplacé ?)' :
      ''
    throw new Error(`Graph PATCH isRead: ${res.status}${hint}${snippet}`)
  }
  return { ok: true, status: res.status }
}
