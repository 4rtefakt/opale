// routes/reviews.js : points informatiques (migration 078) — CRUD + ACL admin.
// Les dates de période sont des DATE Postgres : elles doivent ressortir telles
// quelles ('YYYY-MM-DD'), jamais décalées d'un jour par une conversion en Date
// locale (cf. lib/pg-types.js).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import reviewsRoute from '../../modules/monitoring/routes/reviews.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify, jwt

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()
  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => { await f.register(reviewsRoute, { prefix: '/api/reviews' }) },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

async function adminToken(entraId = 'oid-rev-admin') {
  const u = await seedAdmin(db, { entraId, displayName: 'Admin Points', email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId = 'oid-rev-user') {
  const u = await seedNonAdmin(db, { entraId, displayName: 'User Points', email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

function call(token, method, url, payload) {
  return fastify.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
}

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/reviews/' })
  assert.equal(res.statusCode, 401)
})

test('POST / — non-admin → 403 ; titre vide → 400', { skip: SKIP }, async () => {
  const user = await userToken()
  assert.equal((await call(user, 'POST', '/api/reviews/', { title: 'X' })).statusCode, 403)
  const admin = await adminToken()
  const res = await call(admin, 'POST', '/api/reviews/', { title: '   ' })
  assert.equal(res.statusCode, 400)
})

test('POST puis GET — période rendue en YYYY-MM-DD sans décalage de fuseau', { skip: SKIP }, async () => {
  const admin = await adminToken('oid-rev-admin-dates')
  const created = await call(admin, 'POST', '/api/reviews/', {
    title: 'Point de septembre',
    period_start: '2026-09-14',
    period_end: '2026-09-28',
    snapshot: { devices: 12 },
    sections: [{ key: 'parc', text: 'RAS' }],
  })
  assert.equal(created.statusCode, 201, created.body)
  const body = created.json()
  assert.equal(body.period_start, '2026-09-14')
  assert.equal(body.period_end, '2026-09-28')
  assert.equal(body.created_by_name, 'Admin Points')

  const one = await call(admin, 'GET', `/api/reviews/${body.id}`)
  assert.equal(one.statusCode, 200)
  assert.equal(one.json().period_start, '2026-09-14')
  assert.deepEqual(one.json().snapshot, { devices: 12 })
  assert.deepEqual(one.json().sections, [{ key: 'parc', text: 'RAS' }])

  const list = await call(admin, 'GET', '/api/reviews/')
  assert.equal(list.statusCode, 200)
  const row = list.json().find(r => r.id === body.id)
  assert.ok(row)
  assert.equal(row.period_end, '2026-09-28')
  assert.equal(row.section_count, 1)
  assert.equal(row.snapshot, undefined, 'la liste ne porte pas le snapshot')

  const { rows: logs } = await db.query("SELECT target FROM audit_logs WHERE action = 'review_created'")
  assert.ok(logs.some(l => l.target === 'Point de septembre'))
})

test('PATCH /:id — mise à jour partielle ; sans champ → 400 ; inexistant → 404', { skip: SKIP }, async () => {
  const admin = await adminToken('oid-rev-admin-patch')
  const { id } = (await call(admin, 'POST', '/api/reviews/', { title: 'À renommer', period_start: '2026-01-01' })).json()

  const res = await call(admin, 'PATCH', `/api/reviews/${id}`, { title: 'Renommé', period_end: '2026-01-31' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().title, 'Renommé')
  assert.equal(res.json().period_start, '2026-01-01')
  assert.equal(res.json().period_end, '2026-01-31')

  assert.equal((await call(admin, 'PATCH', `/api/reviews/${id}`, {})).statusCode, 400)
  assert.equal((await call(admin, 'PATCH', `/api/reviews/${id}`, { title: '' })).statusCode, 400)
  const missing = await call(admin, 'PATCH', '/api/reviews/00000000-0000-0000-0000-000000000000', { title: 'x' })
  assert.equal(missing.statusCode, 404)
})

test('DELETE /:id — 204 puis 404', { skip: SKIP }, async () => {
  const admin = await adminToken('oid-rev-admin-del')
  const { id } = (await call(admin, 'POST', '/api/reviews/', { title: 'À supprimer' })).json()
  assert.equal((await call(admin, 'DELETE', `/api/reviews/${id}`)).statusCode, 204)
  assert.equal((await call(admin, 'DELETE', `/api/reviews/${id}`)).statusCode, 404)
  assert.equal((await call(admin, 'GET', `/api/reviews/${id}`)).statusCode, 404)
})
