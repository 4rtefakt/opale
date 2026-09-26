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
import websocket from '@fastify/websocket'
import { startFakeSshServer, sshClientEnv, trackUnhandledRejections } from '../helpers/fake-ssh.js'

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
      await f.register(websocket)
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

// Ouverture du terminal : ip_netbird est remonté par l'agent. Un nom d'hôte
// (agent compromis, valeur antérieure à la validation du checkin) ne doit
// jamais devenir la cible du SSH : ni session journalisée, ni connexion.
test('WS /:deviceId — ip_netbird qui n\'est pas une IP → erreur, aucune session ni connexion SSH', { skip: SKIP }, async () => {
  const { token } = await adminJwt('oid-ssh-bad-ip')
  const device = await seedDevice(db, { hostname: 'PC-SSH-BADIP', ipNetbird: 'localhost' })
  const grant = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: device.id, reason: { category: 'maintenance', note: 'test ip invalide' } },
  })
  assert.equal(grant.statusCode, 200)

  const messages = []
  let closed
  const closedP = new Promise((r) => { closed = r })
  const ws = await fastify.injectWS(`/api/ssh/${device.id}?nonce=${grant.json().nonce}`, {}, {
    onInit: (sock) => {
      sock.on('message', (m) => messages.push(JSON.parse(m.toString())))
      sock.on('close', () => closed())
    },
  })
  await Promise.race([closedP, new Promise((r) => setTimeout(r, 3000))])
  ws.terminate()

  assert.equal(messages[0]?.type, 'error', JSON.stringify(messages))
  assert.match(messages[0].data, /invalide/)
  assert.ok(!messages.some(m => m.type === 'status'), 'aucune tentative de connexion')
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM remote_sessions WHERE device_id = $1`, [device.id])
  assert.equal(rows[0].n, 0, 'aucune session SSH journalisée')
})

test('WS /:deviceId — clé d\'hôte SSH différente de l\'empreinte connue → erreur explicite, aucun shell ouvert', { skip: SKIP, timeout: 20000 }, async (t) => {
  const impostor = await startFakeSshServer(t)
  sshClientEnv(t, impostor.port)
  const { token } = await adminJwt('oid-ssh-hostkey')
  const device = await seedDevice(db, { hostname: 'PC-SSH-HOSTKEY', ipNetbird: '127.0.0.1' })
  await db.query(`UPDATE devices SET ssh_host_key_fp = 'empreinte-connue' WHERE id = $1`, [device.id])
  const grant = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: device.id, reason: { category: 'maintenance', note: 'test clé d\'hôte' } },
  })
  assert.equal(grant.statusCode, 200)

  const messages = []
  let closed
  const closedP = new Promise((r) => { closed = r })
  const ws = await fastify.injectWS(`/api/ssh/${device.id}?nonce=${grant.json().nonce}`, {}, {
    onInit: (sock) => {
      sock.on('message', (m) => messages.push(JSON.parse(m.toString())))
      sock.on('close', () => closed())
    },
  })
  await Promise.race([closedP, new Promise((r) => setTimeout(r, 8000))])
  ws.terminate()

  const errors = messages.filter(m => m.type === 'error').map(m => m.data)
  assert.ok(errors.some(e => /Clé d'hôte SSH inattendue/.test(e)), JSON.stringify(messages))
  // Le message explicite n'est pas suivi de l'erreur générique de ssh2
  // (« Host denied »), qui masquait le motif dans la barre d'état.
  assert.equal(errors.length, 1, JSON.stringify(errors))
  assert.equal(impostor.state.execs, 0, 'aucun shell ouvert chez l\'imposteur')
})

// Ouvre le terminal WS sur un poste et collecte les messages jusqu'à la
// fermeture (ou 8 s).
async function openTerminal(device, token, note) {
  const grant = await fastify.inject({
    method: 'POST', url: '/api/ssh/grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: device.id, reason: { category: 'maintenance', note } },
  })
  assert.equal(grant.statusCode, 200)
  const messages = []
  let closed
  const closedP = new Promise((r) => { closed = r })
  const ws = await fastify.injectWS(`/api/ssh/${device.id}?nonce=${grant.json().nonce}`, {}, {
    onInit: (sock) => {
      sock.on('message', (m) => messages.push(JSON.parse(m.toString())))
      sock.on('close', () => closed())
    },
  })
  await Promise.race([closedP, new Promise((r) => setTimeout(r, 8000))])
  ws.terminate()
  return messages
}

async function waitForSessionEnd(deviceId) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.query(
      `SELECT ended_at FROM remote_sessions WHERE device_id = $1`, [deviceId])
    if (rows[0]?.ended_at) return rows[0].ended_at
    await new Promise(r => setTimeout(r, 20))
  }
  return null
}

test('WS /:deviceId — premier contact : empreinte apprise avant l\'ouverture du shell', { skip: SKIP, timeout: 20000 }, async (t) => {
  const server = await startFakeSshServer(t, { output: 'PS C:\\> ' })
  sshClientEnv(t, server.port)
  const { token } = await adminJwt('oid-ssh-hostkey-learn')
  const device = await seedDevice(db, { hostname: 'PC-SSH-LEARN', ipNetbird: '127.0.0.1' })

  const messages = await openTerminal(device, token, 'test premier contact')

  assert.ok(messages.some(m => m.type === 'status' && m.data === 'Connecté'), JSON.stringify(messages))
  assert.ok(messages.some(m => m.type === 'data'), 'sortie du shell relayée')
  assert.equal(server.state.execs, 1)
  const { rows: [d] } = await db.query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [device.id])
  assert.ok(d.ssh_host_key_fp, 'empreinte mémorisée')
  const { rows: audit } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'ssh_host_key_learned' AND target = $1`, [device.id])
  assert.equal(audit.length, 1)
  assert.equal(audit[0].details.fingerprint, d.ssh_host_key_fp)
})

test('WS /:deviceId — hôte qui raccroche après authentification : erreur, session close, API intacte', { skip: SKIP, timeout: 20000 }, async (t) => {
  const rejections = trackUnhandledRejections(t)
  const server = await startFakeSshServer(t, { endOnReady: true })
  sshClientEnv(t, server.port)
  const { token } = await adminJwt('oid-ssh-hangup')
  const device = await seedDevice(db, { hostname: 'PC-SSH-HANGUP', ipNetbird: '127.0.0.1' })

  const messages = await openTerminal(device, token, 'test raccroché')

  assert.ok(!messages.some(m => m.type === 'status' && m.data === 'Connecté'), JSON.stringify(messages))
  const errors = messages.filter(m => m.type === 'error')
  assert.equal(errors.length, 1, JSON.stringify(messages))
  assert.equal(server.state.execs, 0)
  assert.ok(await waitForSessionEnd(device.id), 'remote_sessions.ended_at renseigné')
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(rejections, [])
})
