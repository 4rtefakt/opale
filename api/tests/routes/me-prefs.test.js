// routes/me.js : GET/PATCH /api/me/prefs. On vérifie le contrat d'intégration
// (auth obligatoire, identité dérivée du token, merge superficiel JSONB,
// rejet des valeurs invalides à la frontière). DB réelle via acquireSchema()
// — gated sur PG_TEST_URL comme les autres suites d'intégration.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedNonAdmin } from '../fixtures/users.js'

import meRoute from '../../modules/core/routes/me.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify, jwt, user
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  // user_prefs.entra_id est FK vers users_cache → on seed le user qui auth.
  // Pas besoin d'admin : la route n'exige que `authenticate`.
  user = await seedNonAdmin(db, { entraId: 'oid-prefs-user', displayName: 'Prefs User' })

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(meRoute, { prefix: '/api/me' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

async function authHeaders() {
  const token = await jwt.sign({ oid: user.entraId, name: user.displayName })
  return { authorization: `Bearer ${token}` }
}

test('GET /prefs — 401 sans token', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/me/prefs' })
  assert.equal(res.statusCode, 401)
})

test('GET /prefs — {} quand aucune pref enregistrée', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/me/prefs', headers: await authHeaders() })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {})
})

test('PATCH /prefs — enregistre mobile_nav puis GET le relit', { skip: SKIP }, async () => {
  const patch = { mobile_nav: ['tickets', 'alertes', 'dashboard'] }
  const res = await fastify.inject({ method: 'PATCH', url: '/api/me/prefs', headers: await authHeaders(), payload: patch })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().mobile_nav, patch.mobile_nav)

  const get = await fastify.inject({ method: 'GET', url: '/api/me/prefs', headers: await authHeaders() })
  assert.deepEqual(get.json().mobile_nav, patch.mobile_nav)
})

test('PATCH /prefs — merge superficiel : préserve les autres clés', { skip: SKIP }, async () => {
  // Pose une clé "étrangère" en base directement (pas via la route validée),
  // puis vérifie qu'un PATCH mobile_nav ne l'écrase pas.
  await db.query(
    `INSERT INTO user_prefs (entra_id, prefs) VALUES ($1, '{"foo":"bar"}'::jsonb)
     ON CONFLICT (entra_id) DO UPDATE SET prefs = user_prefs.prefs || '{"foo":"bar"}'::jsonb`,
    [user.entraId]
  )
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/me/prefs', headers: await authHeaders(),
    payload: { mobile_nav: ['dashboard'] },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.foo, 'bar')
  assert.deepEqual(body.mobile_nav, ['dashboard'])
})

test('PATCH /prefs — 400 sur mobile_nav invalide (route hors liste)', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/me/prefs', headers: await authHeaders(),
    payload: { mobile_nav: ['settings'] },
  })
  assert.equal(res.statusCode, 400)
})

test('PATCH /prefs — 400 sur clé de préférence inconnue', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/me/prefs', headers: await authHeaders(),
    payload: { theme: 'dark' },
  })
  assert.equal(res.statusCode, 400)
})
