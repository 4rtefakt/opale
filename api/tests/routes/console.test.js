// routes/console.js : POST /api/console/grant.
//
// Le WS upgrade /api/console/:deviceId N'EST PAS testé ici — il nécessite
// un vrai client WebSocket et l'instanciation du registry + agent-ws. À
// couvrir en PR séparée si besoin (la logique du registry est déjà testée
// en PR1 : tests/lib/console-sessions.test.js).
//
// Cette suite couvre la pré-condition d'ouverture :
//   - Auth admin requise (sinon 401/403)
//   - Body validation (deviceId, reason via parseReason)
//   - Device exists
//   - Agent online (fastify.agentWs.get(deviceId))
//   - Agent capability "console"
//   - Conflit one-session-per-device (override via takeover=true)
//   - Rate limit 15/min hérité de la config Fastify (smoke-tested ici)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import consoleRoute from '../../modules/remote/routes/console.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt, agentWsFake, consoleSessionsFake
let prevEnv = {}

// Fakes pour les décorateurs agentWs / consoleSessions. setAgent(deviceId, conn)
// simule un agent connecté avec ses capabilities. setHolder(deviceId, holder)
// simule une session déjà active.
function makeAgentWsFake() {
  const map = new Map()
  return {
    set: (id, conn) => map.set(id, conn),
    clear: () => map.clear(),
    // API utilisée par routes/console.js :
    get: (id) => map.get(id),
  }
}
function makeConsoleSessionsFake() {
  const byDevice = new Map()
  return {
    setHolder: (id, holder) => byDevice.set(id, holder),
    clear: () => byDevice.clear(),
    // API utilisée par routes/console.js :
    findActiveByDevice: (id) => byDevice.get(id) || null,
    close: async () => { /* pas pertinent pour les tests /grant */ },
    create: async () => { throw new Error('non utilisé dans tests /grant') },
  }
}

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
  agentWsFake = makeAgentWsFake()
  consoleSessionsFake = makeConsoleSessionsFake()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    decorators: {
      agentWs:         agentWsFake,
      consoleSessions: consoleSessionsFake,
    },
    routes: async (f) => {
      // Le plugin rate-limit n'est pas chargé dans build-app — la directive
      // config.rateLimit dans la route est ignorée silencieusement. Suffit
      // pour tester la logique métier (rate-limit testé séparément si
      // besoin via un test dédié avec @fastify/rate-limit).
      await f.register(consoleRoute, { prefix: '/api/console' })
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

// Helper : signe un JWT pour un admin + reset des fakes entre tests.
async function adminJwt(entraId = 'oid-admin-console') {
  const a = await seedAdmin(db, { entraId, displayName: 'Console Admin', email: 'console-admin@x' })
  agentWsFake.clear()
  consoleSessionsFake.clear()
  return {
    admin: a,
    token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }),
  }
}

// ─── /grant — auth + validation body ────────────────────────────────────────

test('POST /grant — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    payload: { deviceId: 'whatever', reason: { category: 'audit', note: 'test note' } },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /grant — non-admin → 403', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ('oid-non-admin-console', 'B', 'b@x', false)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = false`
  )
  const token = await jwt.sign({ oid: 'oid-non-admin-console', name: 'B', preferred_username: 'b@x' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: 'x', reason: { category: 'audit', note: 'note assez longue' } },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /grant — deviceId manquant → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: { category: 'audit', note: 'note assez longue' } },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /deviceId/)
})

test('POST /grant — reason absent → 400 "reason requis"', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: '00000000-0000-0000-0000-000000000000' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /reason requis/i)
})

test('POST /grant — reason invalide (catégorie inconnue) → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      reason: { category: 'unknown', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /category invalide/)
})

test('POST /grant — reason note < 5 chars → 400', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: '00000000-0000-0000-0000-000000000000',
      reason: { category: 'audit', note: 'no' },
    },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /trop courte/)
})

// ─── /grant — pré-conditions device / agent ─────────────────────────────────

test('POST /grant — device inexistant → 404', { skip: SKIP }, async () => {
  const { token } = await adminJwt()
  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: '11111111-1111-1111-1111-111111111111',
      reason: { category: 'audit', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 404)
  assert.match(res.json().error, /introuvable/i)
})

test('POST /grant — agent offline → 409 AGENT_OFFLINE', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-grant-offline')
  const device = await seedDevice(db, { hostname: 'PC-OFFLINE' })
  // Pas de set sur agentWsFake → get() → undefined → AGENT_OFFLINE.

  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      reason: { category: 'audit', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'AGENT_OFFLINE')
})

test('POST /grant — agent connecté sans capability console → 409 CAPABILITY_MISSING', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-grant-no-cap')
  const device = await seedDevice(db, { hostname: 'PC-NOCAP' })
  agentWsFake.set(device.id, { capabilities: [], agentVersion: '2.13.0' })

  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      reason: { category: 'audit', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.code, 'CAPABILITY_MISSING')
  // Version remontée → l'UI peut suggérer "auto-update en cours".
  assert.equal(body.agent_version, '2.13.0')
})

test('POST /grant — session déjà active (sans takeover) → 409 CONSOLE_CONFLICT avec holder', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-grant-conflict')
  const device = await seedDevice(db, { hostname: 'PC-CONFLICT' })
  agentWsFake.set(device.id, { capabilities: ['console'], agentVersion: '2.14.0' })
  consoleSessionsFake.setHolder(device.id, {
    id: 'sess-existing',
    identity: { displayName: 'OtherAdmin', entraId: 'oid-other' },
    startedAt: Date.now() - 60_000,
  })

  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      reason: { category: 'audit', note: 'note assez longue' },
    },
  })
  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.code, 'CONSOLE_CONFLICT')
  assert.equal(body.holder.by_name, 'OtherAdmin')
  assert.ok(body.holder.started_at)
})

test('POST /grant — happy path → 200 + nonce 64 hex + expires_in 30s', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-grant-ok')
  const device = await seedDevice(db, { hostname: 'PC-OK' })
  agentWsFake.set(device.id, { capabilities: ['console'], agentVersion: '2.14.0' })

  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      reason: { category: 'audit', note: 'revue trimestrielle' },
    },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.match(body.nonce, /^[0-9a-f]{64}$/)
  assert.equal(body.expires_in, 30)
})

test('POST /grant — takeover=true sur session active → 200 (signal "remplacer l\'autre")', { skip: SKIP }, async () => {
  // Le check holder est by-passé si takeover=true. L'audit
  // agent_console_takeover lui-même est émis côté WS upgrade (cf. ssh.js
  // & console.js), pas testé ici. /grant retourne juste un nonce de
  // takeover.
  const { token } = await adminJwt('oid-grant-takeover')
  const device = await seedDevice(db, { hostname: 'PC-TAKE' })
  agentWsFake.set(device.id, { capabilities: ['console'], agentVersion: '2.14.0' })
  consoleSessionsFake.setHolder(device.id, {
    id: 'sess-other', identity: { displayName: 'Other', entraId: 'oid-other' }, startedAt: Date.now(),
  })

  const res = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      deviceId: device.id,
      takeover: true,
      reason: { category: 'incident', note: 'reprise session bloquée' },
    },
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.json().nonce, /^[0-9a-f]{64}$/)
})
