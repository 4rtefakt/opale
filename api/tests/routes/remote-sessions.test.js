// routes/remote-sessions.js : GET /api/remote-sessions/:id/log
//
// Comportement attendu :
//   - table remote_session_logs présente + row trouvée → { available: true, frames, … }
//   - table présente + row absente → { available: false, reason: 'no-log-for-session' }
//   - session inexistante → 404
//   - auth admin requis

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedRemoteSession, seedRemoteSessionLog } from '../fixtures/remote-sessions.js'

import remoteSessionsRoute from '../../modules/remote/routes/remote-sessions.js'

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
      // La route est enregistrée sous /api (pas de prefix supplémentaire) :
      // le handler déclare GET /remote-sessions/:id/log en chemin absolu.
      await f.register(remoteSessionsRoute, { prefix: '/api' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-rs-admin', name = 'Admin RS') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET /api/remote-sessions/:id/log — sans JWT → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'GET',
    url: '/api/remote-sessions/00000000-0000-0000-0000-000000000000/log',
  })
  assert.equal(res.statusCode, 401)
})

test('GET /api/remote-sessions/:id/log — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-rs-nonadmin', email: 'nonadmin-rs@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'GET',
    url: '/api/remote-sessions/00000000-0000-0000-0000-000000000000/log',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── Session inexistante ──────────────────────────────────────────────────────

test('GET /api/remote-sessions/:id/log — session inexistante → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rs-404')
  const res = await fastify.inject({
    method: 'GET',
    url: '/api/remote-sessions/00000000-0000-0000-0000-000000000000/log',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
  assert.ok(res.json().error)
})

// ─── Session avec log ─────────────────────────────────────────────────────────

test('GET /api/remote-sessions/:id/log — session avec log → available:true + frames', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rs-with-log')
  const device = await seedDevice(db, { hostname: 'PC-RS-LOG' })
  const session = await seedRemoteSession(db, { deviceId: device.id })
  const frames = [{ ts_ms: 0, direction: 'out', b64: 'aGVsbG8=' }, { ts_ms: 100, direction: 'in', b64: 'd29ybGQ=' }]
  await seedRemoteSessionLog(db, { sessionId: session.id, frames, sizeBytes: 10 })

  const res = await fastify.inject({
    method: 'GET',
    url: `/api/remote-sessions/${session.id}/log`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.available, true)
  assert.ok(Array.isArray(body.frames))
  assert.equal(body.frames.length, 2)
  assert.equal(body.frames[0].direction, 'out')
  assert.equal(body.size_bytes, 10)
  assert.equal(body.truncated, false)
  assert.ok(body.session)
})

// ─── Session sans log ─────────────────────────────────────────────────────────

test('GET /api/remote-sessions/:id/log — session sans log → available:false, reason:no-log-for-session', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rs-nolog')
  const device = await seedDevice(db, { hostname: 'PC-RS-NOLOG' })
  const session = await seedRemoteSession(db, { deviceId: device.id })
  // Pas d'INSERT dans remote_session_logs

  const res = await fastify.inject({
    method: 'GET',
    url: `/api/remote-sessions/${session.id}/log`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.available, false)
  assert.equal(body.reason, 'no-log-for-session')
  assert.ok(body.session)
})
