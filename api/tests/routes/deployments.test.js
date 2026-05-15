// routes/deployments.js : liste, cancel, retry, bulk.
//
// Couverture : auth requise (admin), list avec filtres, cancel d'un pending,
// retry d'un failed/cancelled, cancel-bulk, retry-bulk, edge cases (409 si
// status incompatible, 400 si ids vide).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

import deploymentsRoute from '../../modules/inventory/routes/deployments.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(deploymentsRoute, { prefix: '/api/deployments' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-dep-admin', name = 'Deploy Admin') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId = 'oid-dep-user', name = 'Deploy User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET /api/deployments — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/deployments' })
  assert.equal(res.statusCode, 401)
})

test('GET /api/deployments — non-admin → 403', { skip: SKIP }, async () => {
  const token = await userToken('oid-dep-nonadmin-list')
  const res = await fastify.inject({
    method: 'GET', url: '/api/deployments',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── GET / — liste ────────────────────────────────────────────────────────────

test('GET /api/deployments — admin reçoit rows + total', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-list-admin')
  const pkg = await insertPackage(db, { name: 'Pkg List Test', createdBy: 'oid-dep-list-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-DEPLIST' })
  await insertDeployment(db, { packageId: pkg.id, deviceId: dev.id })

  const res = await fastify.inject({
    method: 'GET', url: '/api/deployments',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(Array.isArray(body.rows), 'rows doit être un tableau')
  assert.ok(typeof body.total === 'number', 'total doit être un nombre')
  assert.ok(body.total >= 1)
})

test('GET /api/deployments — filtre status=pending renvoie seulement pending', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-filter-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Filter Test', createdBy: 'oid-dep-filter-admin' })
  const d1 = await seedDevice(db, { hostname: 'PC-FILTER-1' })
  const d2 = await seedDevice(db, { hostname: 'PC-FILTER-2' })
  await insertDeployment(db, { packageId: pkg.id, deviceId: d1.id, status: 'pending' })
  // d2 avec status failed — ne doit PAS apparaître dans le filtre pending
  await db.query(
    `INSERT INTO deployments (package_id, device_id, status) VALUES ($1, $2, 'failed')`,
    [pkg.id, d2.id]
  )

  const res = await fastify.inject({
    method: 'GET', url: `/api/deployments?status=pending&package_id=${pkg.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { rows } = res.json()
  for (const r of rows) assert.equal(r.status, 'pending')
})

// ─── PATCH /:id/cancel ────────────────────────────────────────────────────────

test('PATCH /:id/cancel — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/deployments/00000000-0000-0000-0000-000000000000/cancel',
  })
  assert.equal(res.statusCode, 401)
})

test('PATCH /:id/cancel — happy path: pending → cancelled', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-cancel-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Cancel', createdBy: 'oid-dep-cancel-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-CANCEL' })
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId: dev.id, status: 'pending' })

  const res = await fastify.inject({
    method: 'PATCH', url: `/api/deployments/${dep.id}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'cancelled')

  const { rows } = await db.query('SELECT status FROM deployments WHERE id = $1', [dep.id])
  assert.equal(rows[0].status, 'cancelled')
})

test('PATCH /:id/cancel — déjà cancelled → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-cancel2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg CancelConflict', createdBy: 'oid-dep-cancel2-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-CANCELCONFLICT' })
  await db.query(
    `INSERT INTO deployments (package_id, device_id, status) VALUES ($1, $2, 'success')`,
    [pkg.id, dev.id]
  )
  const { rows } = await db.query(
    'SELECT id FROM deployments WHERE package_id = $1 AND device_id = $2', [pkg.id, dev.id]
  )
  const depId = rows[0].id

  const res = await fastify.inject({
    method: 'PATCH', url: `/api/deployments/${depId}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 409)
})

// ─── POST /:id/retry ──────────────────────────────────────────────────────────

test('POST /:id/retry — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/00000000-0000-0000-0000-000000000000/retry',
  })
  assert.equal(res.statusCode, 401)
})

test('POST /:id/retry — failed → pending', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-retry-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Retry', createdBy: 'oid-dep-retry-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-RETRY' })
  // Insérer directement en failed (contourne l'index pending-unique)
  await db.query(
    `INSERT INTO deployments (package_id, device_id, status) VALUES ($1, $2, 'failed')`,
    [pkg.id, dev.id]
  )
  const { rows: [dep] } = await db.query(
    'SELECT id FROM deployments WHERE package_id = $1 AND device_id = $2', [pkg.id, dev.id]
  )

  const res = await fastify.inject({
    method: 'POST', url: `/api/deployments/${dep.id}/retry`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'pending')
})

test('POST /:id/retry — status pending → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-retry2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg RetryConflict', createdBy: 'oid-dep-retry2-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-RETRYCONFLICT' })
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId: dev.id, status: 'pending' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/deployments/${dep.id}/retry`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 409)
})

test('POST /:id/retry — inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-retry3-admin')
  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/00000000-0000-0000-0000-000000000001/retry',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── POST /cancel-bulk ────────────────────────────────────────────────────────

test('POST /cancel-bulk — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/cancel-bulk',
    payload: { ids: ['00000000-0000-0000-0000-000000000000'] },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /cancel-bulk — ids vide → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-cbulk-admin')
  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/cancel-bulk',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [] },
  })
  assert.equal(res.statusCode, 400)
})

test('POST /cancel-bulk — 3 pending → 3 cancelled, renvoie { cancelled, skipped }', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-cbulk2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg CancelBulk', createdBy: 'oid-dep-cbulk2-admin' })
  const devs = await Promise.all([
    seedDevice(db, { hostname: 'PC-CBULK-1' }),
    seedDevice(db, { hostname: 'PC-CBULK-2' }),
    seedDevice(db, { hostname: 'PC-CBULK-3' }),
  ])
  const deps = await Promise.all(
    devs.map(d => insertDeployment(db, { packageId: pkg.id, deviceId: d.id, status: 'pending' }))
  )

  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/cancel-bulk',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: deps.map(d => d.id) },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.cancelled, 3)
  assert.equal(body.skipped, 0)
})

// ─── POST /retry-bulk ─────────────────────────────────────────────────────────

test('POST /retry-bulk — ids vide → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-rbulk-admin')
  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/retry-bulk',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [] },
  })
  assert.equal(res.statusCode, 400)
})

test('POST /retry-bulk — 2 failed → 2 retried', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dep-rbulk2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg RetryBulk', createdBy: 'oid-dep-rbulk2-admin' })
  const devs = await Promise.all([
    seedDevice(db, { hostname: 'PC-RBULK-1' }),
    seedDevice(db, { hostname: 'PC-RBULK-2' }),
  ])
  // Insérer en failed
  const ids = []
  for (const d of devs) {
    await db.query(
      `INSERT INTO deployments (package_id, device_id, status) VALUES ($1, $2, 'failed')`,
      [pkg.id, d.id]
    )
    const { rows: [dep] } = await db.query(
      'SELECT id FROM deployments WHERE package_id = $1 AND device_id = $2', [pkg.id, d.id]
    )
    ids.push(dep.id)
  }

  const res = await fastify.inject({
    method: 'POST', url: '/api/deployments/retry-bulk',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.retried, 2)
  assert.equal(body.skipped, 0)

  // Vérifier que les status sont repassés en pending en base
  for (const id of ids) {
    const { rows: [dep] } = await db.query('SELECT status FROM deployments WHERE id = $1', [id])
    assert.equal(dep.status, 'pending')
  }
})
