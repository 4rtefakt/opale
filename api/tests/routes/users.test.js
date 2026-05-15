// routes/users.js : annuaire users.
//
// Endpoints Graph-dépendants (GET /, GET /:id, GET /search-aad, /:id/photo,
// POST /sync-all) → auth-only (401 sans token). Mocker lib/graph.js au niveau
// module est fragile en node:test ESM — on couvre uniquement le contrat auth.
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
