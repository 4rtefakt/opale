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
// settings, devices) en écoute sur 127.0.0.1, clients `ws` sur une vraie
// socket TCP : le close handshake aboutit des deux côtés, le onClose du
// handler serveur s'exécute (avec injectWS, la socket serveur reste en
// CLOSING jusqu'au timer de 30 s de ws).

import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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

// Client `ws` : celui qu'embarque @fastify/websocket (pas de dépendance
// directe du package api).
const require = createRequire(import.meta.url)
const WebSocket = createRequire(require.resolve('@fastify/websocket'))('ws')

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt, adminAuth, baseUrl
let prevEnv = {}
const openSockets = []

// Espion sur db.query : suivi des requêtes en vol (barrière déterministe,
// cf. settleDb) et interception ponctuelle (interceptQuery), pour placer
// une action entre deux requêtes d'un handler ou simuler une erreur DB.
const inflight = new Set()
let interceptQuery = null  // (sql, params, next) => Promise | null

function spyDbQuery(pool) {
  const orig = pool.query.bind(pool)
  pool.query = (...args) => {
    const next = () => orig(...args)
    const p = (interceptQuery && typeof args[0] === 'string' && interceptQuery(args[0], args[1], next)) || next()
    if (p && typeof p.then === 'function') {
      inflight.add(p)
      p.then(() => inflight.delete(p), () => inflight.delete(p))
    }
    return p
  }
}

// Attend que plus aucune requête ne soit en vol (y compris celles lancées
// par la continuation d'une requête terminée).
async function settleDb() {
  for (;;) {
    await Promise.allSettled([...inflight])
    await new Promise((r) => setImmediate(r))
    if (!inflight.size) return
  }
}

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
  spyDbQuery(db)
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
  await fastify.listen({ port: 0, host: '127.0.0.1' })
  baseUrl = `ws://127.0.0.1:${fastify.server.address().port}`

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

// Fin de test : toute connexion fermée côté client l'est aussi côté serveur
// (onClose exécuté). Sinon son clearInterval(heartbeat) tombe dans le test
// suivant, sur le setInterval simulé de celui-ci : MockTimers retire alors
// un timer de sa propre file par position, et le heartbeat du test suivant
// ne se déclenche plus au tick.
afterEach(async () => {
  interceptQuery = null
  if (!fastify?.websocketServer) return
  await waitFor(
    () => [...fastify.websocketServer.clients].every((s) => s.readyState === WebSocket.OPEN),
    'close côté serveur des connexions fermées par le test'
  )
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
async function openWs(path, headers = {}) {
  const frames = []
  let closeInfo = null
  let onClosed
  const closed = new Promise((r) => { onClosed = r })
  const ws = new WebSocket(baseUrl + path, { headers })
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() }
    onClosed(closeInfo)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
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
  const agent = await openWs('/api/agent/ws', { authorization: `Bearer ${secret}` })
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
  assert.equal(row.end_reason, 'token-revoked', 'cause réelle de la fin de session')
  const closeAudit = await waitFor(() => lastAudit('agent_console_close', device.id), 'audit agent_console_close')
  assert.equal(closeAudit.session_id, browser.sessionId)
  assert.equal(closeAudit.reason, 'token-revoked')
  assert.equal(typeof closeAudit.duration_seconds, 'number')

  const wsAudit = await waitFor(() => lastAudit('agent_ws_disconnect', device.id), 'audit agent_ws_disconnect')
  assert.equal(wsAudit.reason, 'token-revoked')
  assert.equal(wsAudit.token_id, tok.id)
})

async function auditRows(action, target) {
  const { rows } = await db.query(
    'SELECT details FROM audit_logs WHERE action = $1 AND target = $2', [action, target]
  )
  return rows
}

test('évincement : onClose serveur exécuté, un seul agent_ws_disconnect et un seul agent_console_close, heartbeat arrêté', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-ONCLOSE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-onclose' })
  const agent = await connectAgent(tok.secret, device.id)
  const browser = await openConsole(device.id, agent)

  // Envois de la connexion côté serveur (ping du heartbeat) et close de la
  // socket serveur (listener posé après celui du handler → onClose fait).
  const sent = []
  const origSend = agent.conn.send
  agent.conn.send = (type, ...rest) => { sent.push(type); return origSend(type, ...rest) }
  const serverClosed = new Promise((r) => agent.conn.socket.once('close', r))

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${tok.id}`, headers: adminAuth,
  })
  assert.equal(res.statusCode, 204)
  await within(agent.closed, 2000, 'close côté client')
  await within(serverClosed, 2000, 'close côté serveur (onClose du handler)')
  await within(browser.closed, 2000, 'close du browser')
  await settleDb()

  assert.equal(fastify.agentWs.get(device.id), null, 'désenregistrée')
  const ws = await auditRows('agent_ws_disconnect', device.id)
  assert.equal(ws.length, 1, `un seul agent_ws_disconnect : ${JSON.stringify(ws)}`)
  assert.equal(ws[0].details.reason, 'token-revoked')
  const closes = await auditRows('agent_console_close', device.id)
  assert.equal(closes.length, 1, `un seul agent_console_close : ${JSON.stringify(closes)}`)
  assert.equal(closes[0].details.session_id, browser.sessionId)

  // Timer du heartbeat détruit par le onClose : plus de ping.
  t.mock.timers.tick(30_000)
  assert.ok(!sent.includes('ping'), `envois après close : ${sent.join(', ')}`)
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

  // L'évincement est synchrone dans le handler de révocation : état final
  // dès la réponse.
  assert.equal(second.conn.revokedReason, null, 'la connexion du nouveau token n\'est pas évincée')
  assert.equal(fastify.agentWs.get(device.id), second.conn)
  assert.equal(second.closeInfo, null)
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

test('suppression du poste par un UUID non canonique (majuscules) → WS agent fermée', { skip: SKIP }, async () => {
  // Postgres accepte l'UUID en majuscules : le poste est supprimé, la
  // connexion doit l'être aussi (registry indexé par l'id canonique).
  const device = await seedDevice(db, { hostname: 'PC-WS-DELETED-UPPER' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-deleted-upper' })
  const agent = await connectAgent(tok.secret, device.id)

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${device.id.toUpperCase()}`, headers: adminAuth,
  })
  assert.equal(res.statusCode, 204)
  assert.equal(fastify.agentWs.get(device.id), null, 'connexion retirée dès la réponse')
  const info = await within(agent.closed, 2000, 'fermeture de la WS après suppression du poste')
  assert.equal(info.reason, 'device-deleted')
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

// ─── Revalidation du token au heartbeat ─────────────────────────────────────
//
// Expiration (fin de la grace de rotation) et invalidations qui ne passent
// pas par le registry de ce process (autre instance, SQL direct) : c'est le
// tick du heartbeat qui revalide le token. setInterval simulé (le heartbeat
// réel tourne à 30 s) ; setTimeout reste réel pour les attentes.

// Requête de revalidation du token (routes/agent.js, recheckToken).
const isTokenRecheck = (sql) => /FROM agent_tokens WHERE id = \$1/.test(sql)

test('heartbeat : token dans sa grace de rotation → connexion conservée ; grace écoulée → WS fermée', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-EXPIRY' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-expiry' })
  const agent = await connectAgent(tok.secret, device.id)

  // Rotation : l'ancien token reste valide 24 h (checkins en vol).
  const rot = await fastify.inject({
    method: 'POST', url: '/api/agent/rotate-token',
    headers: { authorization: `Bearer ${tok.secret}` },
  })
  assert.equal(rot.statusCode, 200)
  await settleDb()
  const rechecks = []
  interceptQuery = (sql, params, next) => {
    if (isTokenRecheck(sql)) rechecks.push(params[0])
    return next()
  }
  t.mock.timers.tick(30_000)
  // Barrière : la revalidation lancée par le tick et sa décision (synchrone
  // au retour de la requête) sont terminées.
  await settleDb()
  assert.deepEqual(rechecks, [tok.id], 'revalidation faite au tick')
  assert.equal(agent.conn.revokedReason, null, 'token encore valide : connexion conservée')
  assert.equal(fastify.agentWs.get(device.id), agent.conn)
  await waitFor(() => agent.frames.some(f => f.type === 'ping'), 'ping du heartbeat')
  assert.equal(agent.closeInfo, null)
  interceptQuery = null

  // Grace écoulée.
  await db.query(`UPDATE agent_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [tok.id])
  t.mock.timers.tick(30_000)
  const info = await within(agent.closed, 2000, 'fermeture après expiration')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-expired')
  assert.equal(fastify.agentWs.get(device.id), null)

  // L'agent se reconnecte avec le token issu de la rotation.
  const again = await connectAgent(rot.json().token, device.id)
  assert.equal(fastify.agentWs.get(device.id), again.conn)
})

test('heartbeat : token révoqué hors de ce process (autre instance, SQL direct) → WS fermée au tick suivant', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-REMOTE-REVOKE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-remote-revoke' })
  const agent = await connectAgent(tok.secret, device.id)

  await db.query(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [tok.id])
  t.mock.timers.tick(30_000)

  const info = await within(agent.closed, 2000, 'fermeture au tick du heartbeat')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-revoked')
  const g = await grantConsole(device.id)
  assert.equal(g.statusCode, 409)
  assert.equal(g.json().code, 'AGENT_OFFLINE')
})

test('heartbeat : erreur DB à la revalidation → connexion conservée, nouvel essai au tick suivant', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-RECHECK-DBERR' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-recheck-dberr' })
  const agent = await connectAgent(tok.secret, device.id)
  await settleDb()

  let failures = 0
  interceptQuery = (sql, params, next) => {
    if (!isTokenRecheck(sql)) return next()
    failures++
    return Promise.reject(new Error('base indisponible (test)'))
  }
  t.mock.timers.tick(30_000)
  await settleDb()
  assert.equal(failures, 1, 'revalidation tentée au tick')
  assert.equal(agent.conn.revokedReason, null, 'erreur DB : connexion conservée')
  assert.equal(fastify.agentWs.get(device.id), agent.conn)

  // Base rétablie : le tick suivant revalide normalement.
  interceptQuery = null
  await db.query(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [tok.id])
  t.mock.timers.tick(30_000)
  const info = await within(agent.closed, 2000, 'fermeture au tick suivant')
  assert.equal(info.reason, 'token-revoked')
})

test('heartbeat : token rattaché à un autre poste par un checkin (renommage sans série) → WS fermée, raison token-rebound', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-OLDNAME' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-rebind' })
  const agent = await connectAgent(tok.secret, device.id)

  // Nouveau hostname inconnu, sans série : le checkin crée un poste et y
  // rattache le token ; la WS reste enregistrée sous l'ancien.
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${tok.secret}` },
    payload: { hostname: 'PC-WS-NEWNAME' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const newId = res.json().device_id
  assert.notEqual(newId, device.id)

  t.mock.timers.tick(30_000)
  const info = await within(agent.closed, 2000, 'fermeture au tick')
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-rebound')

  // Reconnexion : la WS est enregistrée sous le nouveau poste.
  const again = await connectAgent(tok.secret, newId)
  assert.equal(fastify.agentWs.get(newId), again.conn)
})

test('heartbeat : poste supprimé hors de ce process (tokens en cascade) → WS fermée, raison device-deleted', { skip: SKIP }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-REMOTE-DELETE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-remote-delete' })
  const agent = await connectAgent(tok.secret, device.id)

  await db.query('DELETE FROM devices WHERE id = $1', [device.id])
  t.mock.timers.tick(30_000)
  const info = await within(agent.closed, 2000, 'fermeture au tick')
  assert.equal(info.reason, 'device-deleted')
})

test('socket fermée pendant l\'authentification → rien d\'enregistré, aucun heartbeat, aucun audit de connexion', { skip: SKIP }, async (t) => {
  const device = await seedDevice(db, { hostname: 'PC-WS-AUTH-DROP' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-auth-drop' })

  // Timers créés par le handler (heartbeat) : relevés, et détruits en fin
  // de test pour que le process sorte même si le correctif régresse.
  const intervals = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = function (...args) {
    const h = realSetInterval.apply(this, args)
    intervals.push(h)
    return h
  }
  t.after(() => {
    globalThis.setInterval = realSetInterval
    for (const h of intervals) clearInterval(h)
  })

  // Requête hostname du handler retenue jusqu'à la coupure du client.
  let release, reached
  const gate = new Promise((r) => { release = r })
  const atHostname = new Promise((r) => { reached = r })
  interceptQuery = (sql, params, next) => {
    if (!/SELECT hostname FROM devices WHERE id = \$1/.test(sql)) return next()
    interceptQuery = null
    reached()
    return gate.then(() => next())
  }

  const known = new Set(fastify.websocketServer.clients)
  const agent = await openWs('/api/agent/ws', { authorization: `Bearer ${tok.secret}` })
  await within(atHostname, 2000, 'handler en attente de la requête hostname')
  const serverSocket = [...fastify.websocketServer.clients].find((s) => !known.has(s))
  const serverClosed = new Promise((r) => serverSocket.once('close', r))
  agent.ws.terminate()
  await within(serverClosed, 2000, 'close côté serveur pendant l\'authentification')

  release()
  await settleDb()
  assert.equal(fastify.agentWs.get(device.id), null, 'connexion morte non enregistrée')
  assert.equal(intervals.length, 0, 'aucun heartbeat démarré')
  assert.deepEqual(await auditRows('agent_ws_connect', device.id), [], 'aucun audit de connexion')
})

test('révocation entre l\'authentification et l\'enregistrement de la WS → fermée sans attendre le heartbeat', { skip: SKIP }, async (t) => {
  // Aucun tick : seul un contrôle fait à l'enregistrement peut fermer.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const device = await seedDevice(db, { hostname: 'PC-WS-AUTH-RACE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-auth-race' })

  // Révocation par la route admin pendant la requête hostname du handler
  // WS (après authToken, avant register) : evictTokens ne trouve encore
  // aucune connexion.
  let revoked
  interceptQuery = (sql, params, next) => {
    if (!/SELECT hostname FROM devices WHERE id = \$1/.test(sql)) return next()
    interceptQuery = null
    revoked = Promise.resolve(fastify.inject({
      method: 'DELETE', url: `/api/settings/tokens/${tok.id}`, headers: adminAuth,
    }))
    return revoked.then(() => next())
  }
  const agent = await openWs('/api/agent/ws', { authorization: `Bearer ${tok.secret}` })

  const info = await within(agent.closed, 2000, 'fermeture sans tick du heartbeat')
  assert.equal((await revoked).statusCode, 204)
  assert.equal(info.code, WS_CLOSE.AUTH_FAIL)
  assert.equal(info.reason, 'token-revoked')
  assert.equal(fastify.agentWs.get(device.id), null)
})

// ─── Frames console.* liées à la connexion émettrice ────────────────────────

const b64 = (s) => Buffer.from(s).toString('base64')

test('frames console.* portant le session_id d\'un autre poste → rien transmis, session de l\'autre poste intacte', { skip: SKIP }, async () => {
  const devA = await seedDevice(db, { hostname: 'PC-WS-CONSOLE-A' })
  const devB = await seedDevice(db, { hostname: 'PC-WS-CONSOLE-B' })
  const tokA = await seedAgentToken(db, { deviceId: devA.id, label: 'ws-console-a' })
  const tokB = await seedAgentToken(db, { deviceId: devB.id, label: 'ws-console-b' })
  const agentA = await connectAgent(tokA.secret, devA.id)
  const agentB = await connectAgent(tokB.secret, devB.id)
  const browserA = await openConsole(devA.id, agentA)
  const browserB = await openConsole(devB.id, agentB)
  const sidB = browserB.sessionId

  // L'agent A vise la session de B.
  agentA.send('console.opened', { pid: 666 }, sidB)
  agentA.send('console.data', { b64: b64('injection depuis A') }, sidB)
  agentA.send('console.error', { message: 'faux' }, sidB)
  agentA.send('console.exit', { code: 0, reason: 'exit' }, sidB)

  // Barrière : frame légitime de A sur sa propre session, traitée après
  // les précédentes (même socket, ordre conservé).
  agentA.send('console.data', { b64: b64('marqueur A') }, browserA.sessionId)
  await waitFor(
    () => browserA.frames.some(f => f.type === 'data' && f.data?.b64 === b64('marqueur A')),
    'frame légitime de A reçue par son browser'
  )

  const leaked = browserB.frames.filter(f => ['opened', 'data', 'error', 'exit'].includes(f.type))
  assert.deepEqual(leaked, [], 'aucune frame de A transmise au browser de B')
  assert.equal(browserB.closeInfo, null, 'browser de B non fermé')
  const sessB = fastify.consoleSessions.get(sidB)
  assert.ok(sessB, 'session de B toujours active')
  assert.deepEqual(sessB.buffer.frames, [], 'rien de A dans l\'enregistrement de B')
  assert.equal((await remoteSession(sidB)).ended_at, null)
  assert.ok(!agentB.frames.some(f => f.type === 'console.close'), 'aucun console.close envoyé à B')

  // A reçoit la même réponse que pour une session inconnue.
  await waitFor(
    () => agentA.frames.some(f => f.type === 'console.close' && f.id === sidB && f.data?.reason === 'no-such-session'),
    'console.close no-such-session renvoyé à A'
  )

  // Le chemin légitime de B fonctionne toujours.
  agentB.send('console.data', { b64: b64('sortie de B') }, sidB)
  await waitFor(
    () => browserB.frames.some(f => f.type === 'data' && f.data?.b64 === b64('sortie de B')),
    'frame légitime de B reçue par son browser'
  )
})

test('frames console.* : session légitime servie après une reprise de main puis après une reconnexion de l\'agent', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-CONSOLE-TAKEOVER' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-console-takeover' })
  const agent1 = await connectAgent(tok.secret, device.id)
  const browser1 = await openConsole(device.id, agent1)

  // Reprise de main : nouvelle session sur la même connexion agent.
  const g = await fastify.inject({
    method: 'POST', url: '/api/console/grant',
    headers: adminAuth,
    payload: { deviceId: device.id, takeover: true, reason: { category: 'troubleshoot', note: 'reprise de main test' } },
  })
  assert.equal(g.statusCode, 200, g.body)
  const browser2 = await openWs(`/api/console/${device.id}?nonce=${g.json().nonce}`)
  const open2 = await waitFor(
    () => agent1.frames.find(f => f.type === 'console.open' && f.id !== browser1.sessionId),
    'console.open de la session reprise'
  )
  await within(browser1.closed, 2000, 'ancienne session fermée (taken-over)')
  agent1.send('console.opened', { pid: 42 }, open2.id)
  agent1.send('console.data', { b64: b64('après reprise') }, open2.id)
  await waitFor(() => browser2.frames.some(f => f.type === 'opened'), 'opened transmis après reprise')
  await waitFor(
    () => browser2.frames.some(f => f.type === 'data' && f.data?.b64 === b64('après reprise')),
    'data transmise après reprise'
  )

  // Reconnexion de l'agent : les sessions de l'ancienne connexion sont
  // fermées (pas de transfert), une nouvelle session sur la nouvelle
  // connexion est servie normalement.
  const agent2 = await connectAgent(tok.secret, device.id)
  await within(browser2.closed, 2000, 'session de l\'ancienne connexion fermée')
  const browser3 = await openConsole(device.id, agent2)
  agent2.send('console.data', { b64: b64('après reconnexion') }, browser3.sessionId)
  await waitFor(
    () => browser3.frames.some(f => f.type === 'data' && f.data?.b64 === b64('après reconnexion')),
    'data transmise après reconnexion'
  )
})

test('frames console.* : session du même poste portée par une autre connexion → ignorée', { skip: SKIP }, async () => {
  // Liaison à la connexion, pas seulement au poste : une session créée
  // avec une autre connexion du même poste (ex. la précédente, pendant une
  // reconnexion) n'est pas pilotable depuis celle-ci.
  const device = await seedDevice(db, { hostname: 'PC-WS-CONSOLE-OTHERCONN' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-console-otherconn' })
  const agent = await connectAgent(tok.secret, device.id)

  const browserSent = []
  const browserSocket = { readyState: 1, send: (m) => browserSent.push(JSON.parse(m)), close: () => {} }
  const otherConn = { deviceId: device.id, send: () => true, close: () => {} }
  const sess = await fastify.consoleSessions.create({
    deviceId: device.id, agentConn: otherConn, browserSocket,
    identity: { entraId: 'oid-other-conn', displayName: 'Other Conn' }, shell: 'powershell.exe',
  })

  agent.send('console.data', { b64: b64('mauvaise connexion') }, sess.id)
  agent.send('console.exit', { code: 0, reason: 'exit' }, sess.id)
  // Barrière : la réponse à console.opened arrive après le traitement des
  // frames précédentes.
  agent.send('console.opened', { pid: 1 }, sess.id)
  await waitFor(
    () => agent.frames.some(f => f.type === 'console.close' && f.id === sess.id),
    'console.close no-such-session renvoyé à l\'agent'
  )

  assert.deepEqual(browserSent, [], 'rien transmis au browser de la session')
  assert.ok(fastify.consoleSessions.get(sess.id), 'session toujours active')
  assert.deepEqual(sess.buffer.frames, [])
  await fastify.consoleSessions.close(sess.id, 'test-cleanup')
})

// ─── Ouverture console : connexion agent perdue pendant la création ────────

// Exécute `action` pendant l'INSERT remote_sessions de consoleSessions.create
// (la route console a déjà capturé la connexion agent).
function duringSessionInsert(action) {
  let done
  interceptQuery = (sql, params, next) => {
    if (!/INSERT INTO remote_sessions/.test(sql)) return next()
    interceptQuery = null
    done = Promise.resolve(action())
    return done.then(() => next())
  }
  return () => done
}

async function assertConsoleAborted(device, browser, endReason) {
  await within(browser.closed, 2000, 'browser fermé')
  assert.ok(browser.frames.some(f => f.type === 'error'), `erreur au browser : ${JSON.stringify(browser.frames)}`)
  assert.equal(fastify.consoleSessions.findActiveByDevice(device.id), null, 'poste libéré')
  await settleDb()
  const { rows } = await db.query(
    'SELECT ended_at, end_reason FROM remote_sessions WHERE device_id = $1', [device.id]
  )
  assert.equal(rows.length, 1)
  assert.ok(rows[0].ended_at, 'session marquée terminée')
  assert.equal(rows[0].end_reason, endReason)
}

test('console : token de l\'agent révoqué pendant la création de la session → erreur au browser, poste libéré', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-OPEN-REVOKE' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-open-revoke' })
  await connectAgent(tok.secret, device.id)
  const g = await grantConsole(device.id)
  assert.equal(g.statusCode, 200)

  const revoked = duringSessionInsert(() => fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${tok.id}`, headers: adminAuth,
  }))
  const browser = await openWs(`/api/console/${device.id}?nonce=${g.json().nonce}`)
  await assertConsoleAborted(device, browser, 'token-revoked')
  assert.equal((await revoked()).statusCode, 204)
})

test('console : agent reconnecté pendant la création de la session → erreur au browser, poste libéré, nouvelle console possible', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-WS-OPEN-RECONNECT' })
  const tok = await seedAgentToken(db, { deviceId: device.id, label: 'ws-open-reconnect' })
  await connectAgent(tok.secret, device.id)
  const g = await grantConsole(device.id)
  assert.equal(g.statusCode, 200)

  let agent2
  const reconnected = duringSessionInsert(async () => { agent2 = await connectAgent(tok.secret, device.id) })
  const browser = await openWs(`/api/console/${device.id}?nonce=${g.json().nonce}`)
  await assertConsoleAborted(device, browser, 'superseded')
  await reconnected()

  // La nouvelle connexion sert une nouvelle console normalement.
  const browser2 = await openConsole(device.id, agent2)
  agent2.send('console.data', { b64: b64('après reconnexion') }, browser2.sessionId)
  await waitFor(
    () => browser2.frames.some(f => f.type === 'data' && f.data?.b64 === b64('après reconnexion')),
    'data transmise sur la nouvelle connexion'
  )
})
