let appToken = null
let tokenExpiresAt = 0

// ── OData $search escape ──────────────────────────────────────────────────────
// $search="property:<value>" — selon la spec OData, les `"` et `\` à l'intérieur
// de la valeur doivent être échappés pour éviter qu'un terme injecté ne casse
// la query (et potentiellement élargisse le résultat ou retourne autre chose
// que prévu). On encode aussi la valeur pour l'URL Graph.
function escapeODataSearchTerm(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ── Identifiants interpolés dans un path Graph ───────────────────────────────
// Une valeur venant d'une requête (param de route, body, colonne éditable) ne
// doit JAMAIS être concaténée telle quelle dans un path Graph : Fastify décode
// les params, donc `%2F`, `%3F`, `%23` deviennent `/`, `?`, `#` et réécrivent
// l'URL vers n'importe quel endpoint accessible au token applicatif (ex:
// /users/<x>/messages avec Mail.Read). On valide le format attendu (GUID Entra
// ou UPN au jeu de caractères restreint) PUIS on encode le segment.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// UPN : local-part@domaine DNS. Pas de `/`, `?`, `#`, `%`, `\`, espace, etc.
// Les UPN d'invités (`…#EXT#@…`) ne passent pas : utiliser leur GUID.
const UPN_RE  = /^[A-Za-z0-9._'!^~+-]{1,113}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/

export function isGraphGuid(v) {
  return typeof v === 'string' && GUID_RE.test(v)
}

// Identifiant utilisateur accepté par /users/{id} : GUID ou UPN.
export function isGraphUserId(v) {
  return typeof v === 'string' && v.length <= 256 && (GUID_RE.test(v) || UPN_RE.test(v))
}

function userSegment(userId) {
  if (!isGraphUserId(userId)) throw new Error('Identifiant utilisateur Graph invalide')
  return encodeURIComponent(userId)
}

function guidSegment(id, what) {
  if (!isGraphGuid(id)) throw new Error(`Identifiant ${what} Graph invalide`)
  return encodeURIComponent(id)
}

// Types d'image relayés par le proxy photo. SVG exclu (peut embarquer du
// script s'il est ouvert directement sur l'origin de l'API).
const PHOTO_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'])

// ── Filtre utilisateurs runtime ───────────────────────────────────────────────
// Les clés `users.filter_attribute` et `users.filter_value` permettent de
// restreindre les listings Graph à un sous-ensemble (ex: salariés vs externes).
// Vide = pas de filtre supplémentaire. Cache 60s pour éviter une requête DB
// par appel Graph ; invalidé sur PATCH /api/settings.
const USER_FILTER_TTL_MS = 60_000
let _userFilter = null
let _userFilterAt = 0

async function getUserFilter(db) {
  if (!db) return null
  const now = Date.now()
  if (_userFilterAt && (now - _userFilterAt) < USER_FILTER_TTL_MS) return _userFilter
  const { rows } = await db.query(
    "SELECT key, value FROM settings WHERE key IN ('users.filter_attribute', 'users.filter_value')"
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const attr = (map['users.filter_attribute'] || '').trim()
  const val  = (map['users.filter_value']     || '').trim()
  let filter = null
  // Whitelist anti-injection OData : attribut top-level (ex: department,
  // jobTitle) ou path à 2 niveaux séparés par `/` (ex:
  // onPremisesExtensionAttributes/extensionAttribute1 — requis par Graph
  // pour les attributs étendus on-prem). Pas plus profond, pas d'autres
  // caractères. Échappement des apostrophes dans la valeur (doublage =
  // convention OData).
  if (attr && val && /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?$/.test(attr)) {
    filter = `${attr} eq '${val.replace(/'/g, "''")}'`
  }
  _userFilter = filter
  _userFilterAt = now
  return filter
}

export function invalidateUserFilterCache() {
  _userFilterAt = 0
  _userFilter = null
}

export async function getAppToken() {
  if (appToken && Date.now() < tokenExpiresAt - 60_000) return appToken

  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.ENTRA_CLIENT_ID,
        client_secret: process.env.ENTRA_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default'
      })
    }
  )
  if (!res.ok) throw new Error(`Token Graph: ${res.status}`)
  const data = await res.json()
  appToken = data.access_token
  tokenExpiresAt = Date.now() + data.expires_in * 1000
  return appToken
}

async function graphGet(path) {
  const token = await getAppToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`Graph ${path}: ${res.status}`)
  return res.json()
}

async function graphPost(path, body) {
  const token = await getAppToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Graph POST ${path}: ${res.status} — ${err.error?.message || ''}`)
  }
  return res.status === 204 ? null : res.json()
}

async function graphPatch(path, body) {
  const token = await getAppToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Graph PATCH ${path}: ${res.status} — ${err.error?.message || ''}`)
  }
  return null
}

async function graphDelete(path) {
  const token = await getAppToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok && res.status !== 404) throw new Error(`Graph DELETE ${path}: ${res.status}`)
  return null
}

function tempPassword() {
  const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  return Array.from({ length: 14 }, () => pool[Math.floor(Math.random() * pool.length)]).join('')
}

export async function createEntraUser({ displayName, userPrincipalName, jobTitle, department }) {
  const password = tempPassword()
  const user = await graphPost('/users', {
    displayName,
    userPrincipalName,
    mailNickname: userPrincipalName.split('@')[0],
    jobTitle:     jobTitle || null,
    department:   department || null,
    accountEnabled: true,
    passwordProfile: { forceChangePasswordNextSignIn: true, password }
  })
  return { ...user, temporaryPassword: password }
}

export async function disableEntraUser(userId) {
  return graphPatch(`/users/${userSegment(userId)}`, { accountEnabled: false })
}

export async function addUserToGroup(userId, groupId) {
  return graphPost(`/groups/${guidSegment(groupId, 'de groupe')}/members/$ref`, {
    '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${guidSegment(userId, 'utilisateur')}`
  })
}

export async function revokeUserSessions(userId) {
  return graphPost(`/users/${userSegment(userId)}/revokeSignInSessions`, {})
}

export async function getIntuneDeviceBySerial(fastify, serial) {
  try {
    const encoded = encodeURIComponent(serial)
    const res = await graphGet(
      `/deviceManagement/managedDevices?$filter=serialNumber eq '${encoded}'` +
      `&$select=id,deviceName,userId,userDisplayName,userPrincipalName&$top=1`
    )
    return res.value?.[0] || null
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'Intune: serial lookup échoué')
    return null
  }
}

export async function getEntraUser(fastify, userId) {
  // Id invalide : pas d'appel Graph (cf. userSegment), l'appelant répond 404.
  if (!isGraphUserId(userId)) return null
  try {
    return await graphGet(`/users/${userSegment(userId)}?$select=id,displayName,userPrincipalName,jobTitle,department`)
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'Graph: user lookup échoué')
    return null
  }
}

export async function getAllAADUsers(db) {
  const token = await getAppToken()
  const userFilter = await getUserFilter(db)
  const filter = ["userType eq 'Member'", "accountEnabled eq true", userFilter]
    .filter(Boolean).join(' and ')
  const items = []
  let url = `https://graph.microsoft.com/v1.0/users` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,displayName,userPrincipalName,jobTitle,department,mail,officeLocation` +
    `&$top=999&$orderby=displayName&$count=true`
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
    })
    if (!res.ok) throw new Error(`Graph getAllUsers: ${res.status}`)
    const data = await res.json()
    items.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return items
}

export async function getUserPhoto(userId) {
  if (!isGraphUserId(userId)) return null
  const token = await getAppToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${userSegment(userId)}/photo/$value`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) return null
  // On ne relaie qu'une image : toute autre réponse (JSON, HTML…) est ignorée.
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_CONTENT_TYPES.has(contentType)) return null
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, contentType }
}

export async function syncIntuneDevice(intuneDeviceId) {
  return graphPost(`/deviceManagement/managedDevices/${guidSegment(intuneDeviceId, 'de device Intune')}/syncDevice`, {})
}

export async function searchAADGroups(query) {
  const token = await getAppToken()
  const safe = escapeODataSearchTerm(query)
  const url = `https://graph.microsoft.com/v1.0/groups` +
    `?$search=` + encodeURIComponent(`"displayName:${safe}"`) +
    `&$select=id,displayName,description` +
    `&$top=15`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  })
  if (!res.ok) throw new Error(`Graph groups search: ${res.status}`)
  const data = await res.json()
  return data.value || []
}

// Retourne les displayName (= hostname Windows) des devices membres du groupe Entra.
// Utilisé à la création d'un déploiement scope=group et par le worker group-sync.
export async function getGroupDeviceHostnames(groupId) {
  const items = []
  let url = `https://graph.microsoft.com/v1.0/groups/${guidSegment(groupId, 'de groupe')}/members/microsoft.graph.device` +
    `?$select=displayName&$top=999`
  while (url) {
    const token = await getAppToken()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph group devices ${groupId}: ${res.status}`)
    const data = await res.json()
    items.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return items.map(d => d.displayName).filter(Boolean)
}

export async function getGroupUserIds(groupId) {
  const items = []
  let url = `https://graph.microsoft.com/v1.0/groups/${guidSegment(groupId, 'de groupe')}/members/microsoft.graph.user` +
    `?$select=id&$top=999`
  while (url) {
    const token = await getAppToken()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph group users ${groupId}: ${res.status}`)
    const data = await res.json()
    items.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return items.map(u => u.id).filter(Boolean)
}

export async function searchAADUsers(query, db) {
  const token = await getAppToken()
  const userFilter = await getUserFilter(db)
  // Filtre runtime composable via settings (users.filter_attribute / users.filter_value).
  // Vide = aucun filtre supplémentaire au-delà de userType=Member + accountEnabled.
  const filter = ["userType eq 'Member'", "accountEnabled eq true", userFilter]
    .filter(Boolean).join(' and ')
  const safe = escapeODataSearchTerm(query)
  const url = `https://graph.microsoft.com/v1.0/users` +
    `?$search=` + encodeURIComponent(`"displayName:${safe}" OR "userPrincipalName:${safe}"`) +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$select=id,displayName,userPrincipalName,jobTitle,department` +
    `&$top=15&$orderby=displayName`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  })
  if (!res.ok) throw new Error(`Graph users search: ${res.status}`)
  const data = await res.json()
  return data.value || []
}
