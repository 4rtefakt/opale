// routes/ssh.js : POST /api/ssh/grant.
//
// Pattern identique à /console/grant : auth admin + validation reason +
// device exists. Le WS upgrade (ssh2 vers le poste Windows) n'est pas
// testé ici — il nécessite un faux serveur SSH + clé ed25519 + mock
// reverse-tunnel Netbird, hors scope.
//
// Cette suite couvre la pré-condition d'ouverture :
//   - Auth admin requise
//   - Body validation (deviceId, reason via parseReason)
//   - Device exists
//   - Émission du nonce one-shot 30s

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import sshRoute from '../../modules/remote/routes/ssh.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = {
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(sshRoute, { prefix: '/api/ssh' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function adminJwt(entraId = 'oid-admin-ssh') {
  const a = await seedAdmin(db, { entraId, displayName: 'SSH Admin', email: 'ssh-admin@x' })
  return {
    admin: a,
    token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }),
  }
}

test('POST /grant — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    payload: { deviceId: 'x', reason: { category: 'audit', note: 'note assez longue' } },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /grant — non-admin → 403', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ('oid-ssh-nonadmin', 'N', 'n@x', false)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = false`
  )
  const token = await jwt.sign({ oid: 'oid-ssh-nonadmin', name: 'N', preferred_username: 'n@x' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: 'x', reason: { category: 'audit', note: 'note assez longue' } },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /grant — deviceId manquant → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: { category: 'audit', note: 'note assez longue' } },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /deviceId/)
})

test('POST /grant — reason absent → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: '00000000-0000-0000-0000-000000000000' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /reason requis/i)
})

test('POST /grant — reason note trop courte → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      reason: { category: 'audit', note: 'xx' },
    },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /trop courte/)
})

test('POST /grant — device inexistant → 404', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: '22222222-2222-2222-2222-222222222222',
      reason: { category: 'audit', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 404)
  assert.match(res.json().error, /introuvable/i)
})

test('POST /grant — happy path → 200 + nonce 64 hex + expires_in 30s', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-ssh-ok')
  const device = await seedDevice(db, { hostname: 'PC-SSH-OK', ipNetbird: '100.64.0.1' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      reason: { category: 'maintenance', note: 'maintenance disque' },
    },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.match(body.nonce, /^[0-9a-f]{64}$/)
  assert.equal(body.expires_in, 30)
})
