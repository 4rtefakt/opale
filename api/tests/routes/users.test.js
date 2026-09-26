// routes/users.js : annuaire users.
//
// Endpoints Graph-dépendants (GET /, GET /:id, GET /search-aad, /:id/photo,
// POST /sync-all) → auth-only (401 sans token). Mocker lib/graph.js au niveau
// module est fragile en node:test ESM — on couvre uniquement le contrat auth,
// sauf pour /:id/photo et /:id où globalThis.fetch est stubbé (fin de fichier)
// pour prouver qu'un id injecté n'atteint jamais Graph.
//
// Endpoints DB-only testés en intégration réelle :
//   POST /sync-me  — upsert users_cache + retourne { entraId, isAdmin, … }
//   GET /search    — ILIKE sur display_name + email

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import usersRoute from '../../modules/core/routes/users.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

// Stub Graph : les endpoints Graph-dépendants ne sont pas exercés en logique
// mais la route les importe — on n'injecte pas de mock, juste évite les crash
// au chargement. Le module graph.js est importé par la route elle-même.
// Ici on n'a pas besoin de stub car on ne touche pas les chemins qui appellent
// graph.js dans nos tests.

before(async () => {
  if (!isDbAvailable()) return

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(usersRoute, { prefix: '/api/users' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeAdminToken(entraId, displayName = 'Admin Users', email) {
  const u = await seedAdmin(db, { entraId, displayName, email: email || `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

async function makeUserToken(entraId, displayName = 'User Users', email) {
  const u = await seedNonAdmin(db, { entraId, displayName, email: email || `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

// ─── Auth 401 — endpoints Graph-dépendants ────────────────────────────────────

// GET / appelle getAllAADUsers(Graph) — on couvre uniquement l'auth
test('GET / — sans Bearer → 401 [Graph-dépendant, skip métier]', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/users/' })
  assert.equal(res.statusCode, 401)
})

// GET /:id appelle getEntraUser(Graph) — auth only
test('GET /:id — sans Bearer → 401 [Graph-dépendant, skip métier]', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/users/some-entra-id' })
  assert.equal(res.statusCode, 401)
})

// GET /search-aad appelle searchAADUsers(Graph) — auth only
test('GET /search-aad — sans Bearer → 401 [Graph-dépendant, skip métier]', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/users/search-aad?q=foo' })
  assert.equal(res.statusCode, 401)
})

// GET /:id/photo appelle getUserPhoto(Graph) — auth only
test('GET /:id/photo — sans Bearer → 401 [Graph-dépendant, skip métier]', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/users/some-id/photo' })
  assert.equal(res.statusCode, 401)
})

// POST /sync-all appelle getAllAADUsers(Graph) + requireAdmin — auth only
test('POST /sync-all — sans Bearer → 401 [Graph-dépendant, skip métier]', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'POST', url: '/api/users/sync-all' })
  assert.equal(res.statusCode, 401)
})

// ─── POST /sync-me ────────────────────────────────────────────────────────────

test('POST /sync-me — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'POST', url: '/api/users/sync-me' })
  assert.equal(res.statusCode, 401)
})

test('POST /sync-me — upsert users_cache + retourne contrat attendu', { skip: SKIP }, async () => {
  // Le user n'existe pas encore dans users_cache avant le premier sync-me.
  const entraId = 'oid-syncme-new'
  const token = await jwt.sign({
    oid: entraId,
    name: 'Sync Me User',
    preferred_username: 'syncme@test.local',
  })

  const res = await fastify.inject({
    method: 'POST', url: '/api/users/sync-me',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.entraId, entraId)
  assert.equal(body.displayName, 'Sync Me User')
  assert.equal(body.email, 'syncme@test.local')
  assert.equal(typeof body.isAdmin, 'boolean')
  // jobTitle peut être null — on vérifie juste la présence de la clé
  assert.ok('jobTitle' in body)

  // Vérifier la row insérée en DB
  const { rows } = await db.query('SELECT entra_id, display_name, email FROM users_cache WHERE entra_id = $1', [entraId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].display_name, 'Sync Me User')
})

test('POST /sync-me — isAdmin = true si le user est admin en DB', { skip: SKIP }, async () => {
  const { user, token } = await makeAdminToken('oid-syncme-admin')

  const res = await fastify.inject({
    method: 'POST', url: '/api/users/sync-me',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().isAdmin, true)
})

test('POST /sync-me — deuxième appel met à jour display_name (upsert)', { skip: SKIP }, async () => {
  const entraId = 'oid-syncme-upsert'
  // Premier appel
  await fastify.inject({
    method: 'POST', url: '/api/users/sync-me',
    headers: { authorization: `Bearer ${await jwt.sign({ oid: entraId, name: 'Ancien Nom', preferred_username: 'old@x' })}` },
  })

  // Deuxième appel avec nouveau nom
  const res = await fastify.inject({
    method: 'POST', url: '/api/users/sync-me',
    headers: { authorization: `Bearer ${await jwt.sign({ oid: entraId, name: 'Nouveau Nom', preferred_username: 'new@x' })}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().displayName, 'Nouveau Nom')

  // Vérifier en DB
  const { rows } = await db.query('SELECT display_name FROM users_cache WHERE entra_id = $1', [entraId])
  assert.equal(rows[0].display_name, 'Nouveau Nom')
})

// ─── GET /search ──────────────────────────────────────────────────────────────

test('GET /search — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/users/search?q=foo' })
  assert.equal(res.statusCode, 401)
})

test('GET /search — q trop court (1 char) → retourne tableau vide', { skip: SKIP }, async () => {
  const { token } = await makeUserToken('oid-search-short')
  const res = await fastify.inject({
    method: 'GET', url: '/api/users/search?q=a',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('GET /search — matche par display_name ILIKE', { skip: SKIP }, async () => {
  // Seed un user directement en DB
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email) VALUES ('oid-search-name', 'AliceSearch', 'alice@x') ON CONFLICT DO NOTHING`
  )
  const { token } = await makeUserToken('oid-search-caller-name')
  const res = await fastify.inject({
    method: 'GET', url: '/api/users/search?q=AliceSea',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(Array.isArray(rows))
  assert.ok(rows.some(r => r.entra_id === 'oid-search-name'))
})

test('GET /search — matche par email ILIKE', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email) VALUES ('oid-search-email', 'Bob Unique', 'bob-unique@example.com') ON CONFLICT DO NOTHING`
  )
  const { token } = await makeUserToken('oid-search-caller-email')
  const res = await fastify.inject({
    method: 'GET', url: '/api/users/search?q=bob-unique',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(rows.some(r => r.entra_id === 'oid-search-email'))
  // Vérifie la shape de chaque résultat
  const first = rows.find(r => r.entra_id === 'oid-search-email')
  assert.ok('display_name' in first)
  assert.ok('email' in first)
})

// ─── Proxy photo / détail : injection de path Graph ──────────────────────────
// L'id de route est décodé par Fastify puis interpolé dans un path Graph
// appelé avec le token applicatif (Mail.Read…). `%2F`, `%3F`, `%23` ne
// doivent jamais atteindre fetch. On stubbe globalThis.fetch (graph.js
// l'utilise pour le token ET pour Graph) et on compte les appels.

function mockGraphFetch(photoResponse) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const s = String(url)
    calls.push(s)
    if (/login\.microsoftonline\.com.*token/.test(s)) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    }
    const { status = 200, contentType, body } = photoResponse(s)
    const buf = Buffer.from(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      json: async () => JSON.parse(buf.toString('utf8')),
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const MAIL_JSON = JSON.stringify({ value: [{ subject: 'Confidentiel RH' }] })

test('GET /:id/photo — id injecté (%2Fmessages%3F…%23) → 400, aucun appel Graph', { skip: SKIP }, async () => {
  const { token } = await makeUserToken('oid-photo-inject')
  const mock = mockGraphFetch(() => ({ contentType: 'application/json', body: MAIL_JSON }))
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/users/0f8fad5b-d9cb-469f-a165-70867728950e%2Fmessages%3F%24select%3Dsubject%23/photo',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 400)
    assert.doesNotMatch(res.body, /Confidentiel/)
    assert.equal(mock.calls.length, 0, `aucun fetch attendu, reçu : ${mock.calls.join(', ')}`)
  } finally {
    mock.restore()
  }
})

test('GET /:id/photo — réponse Graph non-image (JSON) → 404, jamais relayée', { skip: SKIP }, async () => {
  const { token } = await makeUserToken('oid-photo-json')
  const mock = mockGraphFetch(() => ({ contentType: 'application/json; charset=utf-8', body: MAIL_JSON }))
  try {
    const res = await fastify.inject({
      method: 'GET', url: '/api/users/1a2b3c4d-0000-4000-8000-00000000abcd/photo',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 404)
    assert.doesNotMatch(res.body, /Confidentiel/)
  } finally {
    mock.restore()
  }
})

test('GET /:id/photo — GUID valide + image/jpeg → relayée, path Graph attendu', { skip: SKIP }, async () => {
  const { token } = await makeUserToken('oid-photo-ok')
  const guid = '2b3c4d5e-0000-4000-8000-00000000beef'
  const mock = mockGraphFetch(() => ({ contentType: 'image/jpeg', body: 'JPEGDATA' }))
  try {
    const res = await fastify.inject({
      method: 'GET', url: `/api/users/${guid}/photo`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'image/jpeg')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.body, 'JPEGDATA')
    const graphCalls = mock.calls.filter(u => u.startsWith('https://graph.microsoft.com/'))
    assert.deepEqual(graphCalls, [`https://graph.microsoft.com/v1.0/users/${guid}/photo/$value`])
  } finally {
    mock.restore()
  }
})

test('GET /:id — admin, id injecté → 400, aucun appel Graph (getEntraUser)', { skip: SKIP }, async () => {
  const { token } = await makeAdminToken('oid-detail-inject')
  const mock = mockGraphFetch(() => ({ contentType: 'application/json', body: MAIL_JSON }))
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/users/0f8fad5b-d9cb-469f-a165-70867728950e%2Fmessages%3F%24select%3Dsubject%23',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 400)
    assert.doesNotMatch(res.body, /Confidentiel/)
    assert.equal(mock.calls.length, 0, `aucun fetch attendu, reçu : ${mock.calls.join(', ')}`)
  } finally {
    mock.restore()
  }
})

// ─── GET / — annuaire admin-only ────────────────────────────────────────────
// L'annuaire expose le poste (hostname) assigné à chaque salarié : réservé
// aux admins. Un non-admin est refusé AVANT tout appel Graph ; /sync-me
// (login) reste ouvert (cf. tests plus haut).

test('GET / — non-admin → 403, aucun appel Graph', { skip: SKIP }, async () => {
  const { token } = await makeUserToken('oid-users-list-na')
  const mock = mockGraphFetch(() => ({ contentType: 'application/json', body: JSON.stringify({ value: [] }) }))
  try {
    const res = await fastify.inject({
      method: 'GET', url: '/api/users/',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

test('GET / — admin → annuaire enrichi du poste assigné', { skip: SKIP }, async () => {
  const { token } = await makeAdminToken('oid-users-list-admin')
  const entraId = '5e6f7081-0000-4000-8000-0000000000aa'
  await db.query(`INSERT INTO users_cache (entra_id, display_name) VALUES ($1, 'Annuaire User') ON CONFLICT DO NOTHING`, [entraId])
  await db.query(`INSERT INTO devices (hostname, assigned_user_id) VALUES ('PC-ANNUAIRE', $1)`, [entraId])
  const mock = mockGraphFetch(() => ({
    contentType: 'application/json',
    body: JSON.stringify({ value: [{ id: entraId, displayName: 'Annuaire User', userPrincipalName: 'annuaire@contoso.fr' }] }),
  }))
  try {
    const res = await fastify.inject({
      method: 'GET', url: '/api/users/',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const u = res.json().find(x => x.entra_id === entraId)
    assert.equal(u.device.hostname, 'PC-ANNUAIRE')
  } finally {
    mock.restore()
  }
})
