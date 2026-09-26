// WS /api/agent/ws : autorisation sur les connexions DÉJÀ ouvertes.
//
// La WS agent n'est authentifiée qu'à l'upgrade. Cette suite vérifie que
// l'invalidation du credential coupe aussi le canal déjà monté :
//   - révocation admin (DELETE /api/settings/tokens/:id), suppression du
//     poste, révocation des tokens jamais utilisés (exchange / checkin) ;
//   - une connexion de remplacement authentifiée par un autre token du
//     même poste n'est pas touchée.
//
// App complète (plugins agent-ws + console-sessions, routes agent, console,
// settings, devices) et vrais clients WS via injectWS (@fastify/websocket).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import websocket from '@fastify/websocket'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'

import agentWsPlugin         from '../../modules/inventory/plugins/agent-ws.js'
import consoleSessionsPlugin from '../../modules/remote/plugins/console-sessions.js'
import agentRoute            from '../../modules/inventory/routes/agent.js'
import devicesRoute          from '../../modules/inventory/routes/devices.js'
import consoleRoute          from '../../modules/remote/routes/console.js'
import settingsRoute         from '../../modules/core/routes/settings.js'
import { WS_CLOSE }          from '../../modules/inventory/lib/agent-ws.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt, adminAuth
let prevEnv = {}
const openSockets = []

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = {
    ENTRA_TENANT_ID:   process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID:   process.env.ENTRA_CLIENT_ID,
    VAPID_PUBLIC_KEY:  process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'
  // VAPID désarmé → sendPushToAll early-return.
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(websocket)
      await f.register(agentWsPlugin)
      await f.register(consoleSessionsPlugin)
      await f.register(settingsRoute, { prefix: '/api/settings' })
      await f.register(devicesRoute,  { prefix: '/api/devices' })
      await f.register(agentRoute,    { prefix: '/api/agent' })
      await f.register(consoleRoute,  { prefix: '/api/console' })
    },
  })

  const a = await seedAdmin(db, { entraId: 'oid-admin-agent-ws', displayName: 'WS Admin', email: 'ws-admin@x' })
  const token = await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })
  adminAuth = { authorization: `Bearer ${token}` }
})

after(async () => {
  for (const s of openSockets) { try { s.ws.terminate() } catch {} }
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function within(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`timeout (${ms} ms) : ${label}`) }),
  ])
}

async function waitFor(fn, label, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await sleep(10)
  }
  throw new Error(`timeout (${ms} ms) : ${label}`)
}

// Client WS qui mémorise les frames reçues et la cause de fermeture.
async function openWs(url, upgradeContext = {}) {
  const frames = []
  let closeInfo = null
  let onClosed
  const closed = new Promise((r) => { onClosed = r })
  const ws = await fastify.injectWS(url, upgradeContext, {
    onInit: (sock) => {
      sock.on('message', (m) => frames.push(JSON.parse(m.toString())))
      sock.on('close', (code, reason) => {
        closeInfo = { code, reason: reason.toString() }
        onClosed(closeInfo)
      })
    },
  })
  const client = {
    ws, frames, closed,
    get closeInfo() { return closeInfo },
    send: (type, data, id) => ws.send(JSON.stringify({ type, id: id ?? null, data: data ?? null })),
  }
  openSockets.push(client)
  return client
}

// Agent connecté : welcome reçu, hello (capability console) traité.
async function connectAgent(secret, deviceId) {
  const agent = await openWs('/api/agent/ws', { headers: { authorization: `Bearer ${secret}` } })
  await waitFor(() => agent.frames.some(f => f.type === 'welcome'), 'welcome agent')
  agent.send('hello', { agent_version: '2.14.0', os: 'windows', arch: 'amd64', capabilities: ['console'] })
  await waitFor(() => fastify.agentWs.get(deviceId)?.capabilities.includes('console'), 'hello traité')
  agent.conn = fastify.agentWs.get(deviceId)
  return agent
}

async function grantConsole(deviceId) {
  return fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: adminAuth,
    payload: { deviceId, reason: { category: 'troubleshoot', note: 'test autorisation WS agent' } },
  })
}

// Ouvre une session console (browser) sur `deviceId` et retourne le
// session_id reçu par l'agent dans console.open.
async function openConsole(deviceId, agent) {
  const g = await grantConsole(deviceId)
  assert.equal(g.statusCode, 200, `grant : ${g.body}`)
  const browser = await openWs(`/api/console/${deviceId}?nonce=${g.json().nonce}`)
  const open = await waitFor(
    () => agent.frames.find(f => f.type === 'console.open'),
    'console.open reçu par l\'agent'
  )
  browser.sessionId = open.id
  return browser
}

async function remoteSession(id) {
  const { rows } = await db.query(
    'SELECT ended_at, end_reason FROM remote_sessions WHERE id = $1', [id]
  )
  return rows[0] || null
}

async function lastAudit(action, target) {
  const { rows } = await db.query(
    `SELECT details FROM audit_logs WHERE action = $1 AND target = $2
     ORDER BY created_at DESC LIMIT 1`,
    [action, target]
  )
  return rows[0]?.details || null
}

// ─── Révocation d'un token → fermeture de la WS ────────────────────────────

test('révocation admin du token → WS agent fermée, session console terminée, plus de grant', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-REVOKE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-revoke' })
  const agent = await connectAgent(tok.secret, device.id)
  const browser = await openConsole(device.id, agent)

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${tok.id}`, headers: adminAuth,
  })
  assert.equal(res.statusCode, 204)

  const info = await within(agent.closed, 2000, 'fermeture de la WS après révocation')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-revoked')
  assert.equal(fastify.agentWs.get(device.id), null, 'connexion retirée du registry')

  // Plus de console possible via ce canal.
  const g = await grantConsole(device.id)
  assert.equal(g.statusCode, 409)
  assert.equal(g.json().code, 'AGENT_OFFLINE')

  // Session console terminée par le teardown normal (row + audit + durée).
  assert.equal(fastify.consoleSessions.get(browser.sessionId), null)
  await within(browser.closed, 2000, 'fermeture du browser')
  const row = await waitFor(async () => {
    const r = await remoteSession(browser.sessionId)
    return r?.ended_at ? r : null
  }, 'remote_sessions.ended_at')
  assert.equal(row.end_reason, 'agent-disconnected')
  const closeAudit = await waitFor(() => lastAudit('agent_console_close', device.id), 'audit agent_console_close')
  assert.equal(closeAudit.session_id, browser.sessionId)
  assert.equal(typeof closeAudit.duration_seconds, 'number')

  const wsAudit = await waitFor(() => lastAudit('agent_ws_disconnect', device.id), 'audit agent_ws_disconnect')
  assert.equal(wsAudit.reason, 'token-revoked')
  assert.equal(wsAudit.token_id, tok.id)
})

test('révocation d\'un ancien token → la connexion de remplacement (autre token du poste) reste ouverte', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-REPLACEMENT' })
  const oldTok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-old' })
  const newTok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-new', createdBy: 'agent-rotation' })

  const first = await connectAgent(oldTok.secret, device.id)
  const second = await connectAgent(newTok.secret, device.id)
  const sup = await within(first.closed, 2000, 'supersede de la première connexion')
  assert.equal(sup.code, WS_CLOSE.SUPERSEDED)

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${oldTok.id}`, headers: adminAuth,
  })
  assert.equal(res.statusCode, 204)

  await sleep(100)
  assert.equal(second.closeInfo, null, 'la connexion du nouveau token n\'est pas fermée')
  assert.equal(fastify.agentWs.get(device.id), second.conn)
  assert.equal((await grantConsole(device.id)).statusCode, 200)
})

test('suppression du poste → WS agent fermée', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-DELETED' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-deleted' })
  const agent = await connectAgent(tok.secret, device.id)

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${device.id}`, headers: adminAuth,
  })
  assert.equal(res.statusCode, 204)

  const info = await within(agent.closed, 2000, 'fermeture de la WS après suppression du poste')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'device-deleted')
  assert.equal(fastify.agentWs.get(device.id), null)
})

test('exchange-token : un token jamais utilisé révoqué à la ré-installation → sa WS est fermée', { skip: SKIP }, async () => {
  // La WS ne pose pas last_used_at : un agent dont le premier checkin n'a
  // pas encore abouti peut avoir un tube ouvert avec un token « jamais
  // utilisé », que la ré-installation révoque.
  const device = await seedDevice(db, { hostname: 'PC-WS-REEXCHANGE' })
  const unused = await seedAgentToken(db, { deviceId: device.id, label: 'ws-unused' })
  const bootstrap = await seedAgentToken(db, { label: 'bs-ws', isBootstrap: true, bootstrapMaxRedeems: 10 })
  const agent = await connectAgent(unused.secret, device.id)

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: { authorization: `Bearer ${bootstrap.secret}` },
    payload: { hostname: 'PC-WS-REEXCHANGE' },
  })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)

  const info = await within(agent.closed, 2000, 'fermeture de la WS du token révoqué')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-revoked')
  assert.equal(fastify.agentWs.get(device.id), null)
})

test('checkin d\'un token non lié : les tokens jamais utilisés révoqués au rattachement → leur WS est fermée', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-BIND' })
  const unused = await seedAgentToken(db, { deviceId: device.id, label: 'ws-bind-unused' })
  const unbound = await seedAgentToken(db, { label: 'ws-bind-unbound' })
  const agent = await connectAgent(unused.secret, device.id)

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${unbound.secret}` },
    payload: { hostname: 'PC-WS-BIND', serial: 'SN-WS-BIND' },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)

  const info = await within(agent.closed, 2000, 'fermeture de la WS du token révoqué')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-revoked')
})
