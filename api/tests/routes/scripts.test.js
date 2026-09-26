// routes/scripts.js — couverture des chemins critiques :
// - CRUD scripts (list, create, get, update, delete)
// - POST /:id/run (queue agent)
// - GET /executions/device/:deviceId
// - POST /:id/exec (validation + chemins 400/404, pas l'exécution SSH réelle)
//
// L'exécution SSH est testée contre un faux serveur SSH local (ssh2.Server,
// clés ed25519 jetables) : finalisation des lignes script_executions.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import scriptsRoute from '../../modules/inventory/routes/scripts.js'
import { startFakeSshServer, sshClientEnv, trackUnhandledRejections } from '../helpers/fake-ssh.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(scriptsRoute, { prefix: '/api/scripts' })
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function adminToken(entraId, name = 'Admin Scripts') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId) {
  const u = await seedNonAdmin(db, { entraId, displayName: 'User', email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function seedScript(opts = {}) {
  const r = await db.query(
    `INSERT INTO scripts (name, code, shell_type) VALUES ($1, $2, $3) RETURNING id`,
    [opts.name ?? 'Script Test', opts.code ?? 'Write-Host OK', opts.shell_type ?? 'powershell']
  )
  return r.rows[0]
}

async function seedGroup(opts = {}) {
  const r = await db.query(
    `INSERT INTO groups (name, color) VALUES ($1, $2) RETURNING id`,
    [opts.name ?? 'G-Test', opts.color ?? 'slate']
  )
  return r.rows[0]
}

// ─── ACL ─────────────────────────────────────────────────────────────────────

test('POST /:id/exec — sans Bearer → 401', { skip: SKIP }, async () => {
  const script = await seedScript()
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    payload: { deviceIds: ['00000000-0000-0000-0000-000000000001'] },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /:id/exec — non-admin → 403', { skip: SKIP }, async () => {
  const token = await userToken('oid-sc-exec-403')
  const script = await seedScript()
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceIds: ['00000000-0000-0000-0000-000000000001'] },
  })
  assert.equal(res.statusCode, 403)
})

// ─── Validation body ─────────────────────────────────────────────────────────

test('POST /:id/exec — body vide → 400 native_group_id requis', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-400-empty')
  const script = await seedScript()
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /native_group_id/)
})

// Valide le rename PR #133 : l'ancien champ group_id est ignoré → même 400
test('POST /:id/exec — group_id (ancien champ) ignoré → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-400-old')
  const script = await seedScript()
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { group_id: '00000000-0000-0000-0000-000000000001' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /native_group_id/)
})

test('POST /:id/exec — script inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-404')
  const res = await fastify.inject({
    method: 'POST', url: '/api/scripts/00000000-0000-0000-0000-000000000000/exec',
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: '00000000-0000-0000-0000-000000000001' },
  })
  assert.equal(res.statusCode, 404)
  assert.match(res.json().error, /Script/)
})

test('POST /:id/exec — native_group_id groupe sans devices → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-400-empty-grp')
  const script = await seedScript()
  const group = await seedGroup({ name: 'G-exec-empty' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /vide/)
})

test('POST /:id/exec — native_group_id groupe avec device sans IP Netbird → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-400-no-ip')
  const script = await seedScript()
  const device = await seedDevice(db, { hostname: 'PC-NOIP', ipNetbird: null })
  const group = await seedGroup({ name: 'G-exec-noip' })
  await db.query(
    `INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1, $2, 'test')`,
    [group.id, device.id]
  )
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /joignable/)
})

// ─── GET / — liste ────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/scripts/' })
  assert.equal(res.statusCode, 401)
})

test('GET / — non-admin → 403', { skip: SKIP }, async () => {
  const token = await userToken('oid-sc-list-403')
  const res = await fastify.inject({
    method: 'GET', url: '/api/scripts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET / — admin → liste avec exec_count', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-list-ok')
  const s = await seedScript({ name: 'Script Liste' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/scripts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const scripts = res.json()
  assert.ok(Array.isArray(scripts))
  const found = scripts.find(x => x.id === s.id)
  assert.ok(found, 'le script créé doit apparaître dans la liste')
  assert.equal(typeof found.exec_count, 'number')
})

// ─── POST / — création ───────────────────────────────────────────────────────

test('POST / — name manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-create-400')
  const res = await fastify.inject({
    method: 'POST', url: '/api/scripts/',
    headers: { authorization: `Bearer ${token}` },
    payload: { code: 'Write-Host OK' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /code|nom/i)
})

test('POST / — code manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-create-400b')
  const res = await fastify.inject({
    method: 'POST', url: '/api/scripts/',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Script sans code' },
  })
  assert.equal(res.statusCode, 400)
})

test('POST / — création réussie → 201 avec shell_type par défaut', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-create-ok')
  const res = await fastify.inject({
    method: 'POST', url: '/api/scripts/',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Mon Script', code: 'ipconfig', description: 'test', category: 'Réseau' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.id)
  assert.equal(body.name, 'Mon Script')
  assert.equal(body.shell_type, 'powershell')
})

// ─── GET /:id — détail ───────────────────────────────────────────────────────

test('GET /:id — script inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-get-404')
  const res = await fastify.inject({
    method: 'GET', url: '/api/scripts/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — retourne le script avec ses executions', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-get-ok')
  const s = await seedScript({ name: 'Script Détail' })
  const res = await fastify.inject({
    method: 'GET', url: `/api/scripts/${s.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.id, s.id)
  assert.ok(Array.isArray(body.executions))
})

// ─── PUT /:id — update ───────────────────────────────────────────────────────

test('PUT /:id — script inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-put-404')
  const res = await fastify.inject({
    method: 'PUT', url: '/api/scripts/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'X' },
  })
  assert.equal(res.statusCode, 404)
})

test('PUT /:id — is_builtin → 403', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-put-builtin')
  // Insérer un script builtin directement
  const r = await db.query(
    `INSERT INTO scripts (name, code, is_builtin, builtin_key) VALUES ($1,$2,true,$3) RETURNING id`,
    ['Builtin Script', 'ipconfig', 'test_builtin_key_put']
  )
  const id = r.rows[0].id
  const res = await fastify.inject({
    method: 'PUT', url: `/api/scripts/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Hacked' },
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /intégré/)
})

test('PUT /:id — aucun champ → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-put-empty')
  const s = await seedScript({ name: 'Script Update Empty' })
  const res = await fastify.inject({
    method: 'PUT', url: `/api/scripts/${s.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

test('PUT /:id — mise à jour réussie', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-put-ok')
  const s = await seedScript({ name: 'Script à Modifier' })
  const res = await fastify.inject({
    method: 'PUT', url: `/api/scripts/${s.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Script Modifié', category: 'Réseau' },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.name, 'Script Modifié')
  assert.equal(body.category, 'Réseau')
})

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

test('DELETE /:id — script inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-del-404')
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/scripts/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('DELETE /:id — is_builtin → 403', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-del-builtin')
  const r = await db.query(
    `INSERT INTO scripts (name, code, is_builtin, builtin_key) VALUES ($1,$2,true,$3) RETURNING id`,
    ['Builtin Del', 'ipconfig', 'test_builtin_key_del']
  )
  const id = r.rows[0].id
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/scripts/${id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /intégré/)
})

test('DELETE /:id — suppression réussie → 204', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-del-ok')
  const s = await seedScript({ name: 'Script à Supprimer' })
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/scripts/${s.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 204)
  // Vérifie que le script n'existe plus
  const { rows } = await db.query('SELECT id FROM scripts WHERE id = $1', [s.id])
  assert.equal(rows.length, 0)
})

// ─── POST /:id/run — queue agent ─────────────────────────────────────────────

test('POST /:id/run — device_id manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-run-400')
  const s = await seedScript()
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${s.id}/run`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /device_id/)
})

test('POST /:id/run — script inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-run-404')
  const res = await fastify.inject({
    method: 'POST', url: '/api/scripts/00000000-0000-0000-0000-000000000000/run',
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: '00000000-0000-0000-0000-000000000001' },
  })
  assert.equal(res.statusCode, 404)
})

test('POST /:id/run — happy path : crée une execution pending → 201', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-run-ok')
  const s = await seedScript({ name: 'Script Run Test' })
  const device = await seedDevice(db, { hostname: 'PC-RUN-AGENT' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${s.id}/run`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  assert.equal(res.statusCode, 201)
  const exec = res.json()
  assert.equal(exec.status, 'pending')
  assert.equal(exec.mode, 'agent')
  assert.equal(exec.device_id, device.id)
  assert.equal(exec.script_id, s.id)
  // Vérifier la row en DB
  const { rows } = await db.query(
    'SELECT status, mode FROM script_executions WHERE id = $1', [exec.id]
  )
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].mode, 'agent')
})

// ─── GET /executions/device/:deviceId ─────────────────────────────────────────

test('GET /executions/device/:deviceId — retourne historique paginé', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-hist')
  const s = await seedScript({ name: 'Script Hist' })
  const device = await seedDevice(db, { hostname: 'PC-HIST' })
  // Insérer deux exécutions pour ce device
  await db.query(
    `INSERT INTO script_executions (script_id, device_id, status, mode) VALUES ($1,$2,'pending','agent')`,
    [s.id, device.id]
  )
  await db.query(
    `INSERT INTO script_executions (script_id, device_id, status, mode) VALUES ($1,$2,'success','agent')`,
    [s.id, device.id]
  )
  const res = await fastify.inject({
    method: 'GET', url: `/api/scripts/executions/device/${device.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(Array.isArray(body.rows))
  assert.ok(body.rows.length >= 2)
  assert.equal(typeof body.total, 'number')
  assert.ok(body.total >= 2)
  assert.equal(body.limit, 20)
})

test('GET /executions/device/:deviceId — device sans executions → total 0', { skip: SKIP }, async () => {
  const token = await adminToken('oid-sc-exec-empty')
  const device = await seedDevice(db, { hostname: 'PC-NO-EXEC' })
  const res = await fastify.inject({
    method: 'GET', url: `/api/scripts/executions/device/${device.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.rows, [])
  assert.equal(body.total, 0)
})

// ─── POST /:id/exec — exécution SSH (faux serveur local) ──────────────────────

const { Server: SshServer, utils: sshUtils } = ssh2

// utils.generateKeyPairSync('ed25519') de ssh2 produit environ 0,2 % de clés
// que son propre parseur refuse (« Malformed OpenSSH private key », mesuré :
// 12 sur 5 000) : c'était la cause des échecs intermittents de ces tests
// (clé cliente illisible → exécution en 'error' en quelques ms). On
// régénère jusqu'à obtenir une clé lisible. Sans effet sur la prod (clés
// générées par ssh-keygen).
function ed25519KeyPair() {
  for (let i = 0; i < 20; i++) {
    const k = sshUtils.generateKeyPairSync('ed25519')
    if (!(sshUtils.parseKey(k.private) instanceof Error)) return k
  }
  throw new Error('ssh2 : aucune clé ed25519 lisible générée')
}

// Serveur SSH local qui accepte toute authentification et répond à exec
// par `output` puis le code de sortie donné.
async function fakeSshServer(t, { output, exitCode = 0 }) {
  const hostKey = ed25519KeyPair()
  const server = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec) => {
          const stream = acceptExec()
          stream.write(output)
          stream.exit(exitCode)
          stream.end()
        })
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return server.address().port
}

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })
}

async function groupWithDevice(name, hostname) {
  const device = await seedDevice(db, { hostname, ipNetbird: '127.0.0.1' })
  const group = await seedGroup({ name })
  await db.query(`INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1, $2, 'test')`, [group.id, device.id])
  return { device, group }
}

async function execRows(scriptId) {
  const { rows } = await db.query(
    `SELECT status, length(output) AS len, output FROM script_executions WHERE script_id = $1`, [scriptId])
  return rows
}

test('POST /:id/exec — sortie SSH > 10 000 caractères : ligne finalisée (tronquée), plus de running bloqué', { skip: SKIP, timeout: 15000 }, async (t) => {
  const port = await fakeSshServer(t, { output: 'o'.repeat(12000) })
  const clientKey = ed25519KeyPair()
  withEnv(t, { SSH_PORT: String(port), SSH_USER: 'opale', SSH_PRIVATE_KEY_B64: Buffer.from(clientKey.private).toString('base64') })
  const token = await adminToken('oid-sc-exec-ssh-long')
  const script = await seedScript({ name: 'SSH long' })
  const { group } = await groupWithDevice('G-exec-ssh-long', 'PC-SSH-LONG')

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /"type":"end"/)
  const rows = await execRows(script.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'success', `sortie : ${rows[0].output?.slice(0, 300)}`)
  assert.equal(rows[0].len, 10000, 'sortie tronquée à la taille de la colonne')
})

test('POST /:id/exec — sortie SSH avec octets NUL : ligne finalisée sans NUL (plus de running bloqué)', { skip: SKIP, timeout: 15000 }, async (t) => {
  const port = await fakeSshServer(t, { output: 'o\u0000k' })
  const clientKey = ed25519KeyPair()
  withEnv(t, { SSH_PORT: String(port), SSH_USER: 'opale', SSH_PRIVATE_KEY_B64: Buffer.from(clientKey.private).toString('base64') })
  const token = await adminToken('oid-sc-exec-ssh-nul')
  const script = await seedScript({ name: 'SSH NUL' })
  const { group } = await groupWithDevice('G-exec-ssh-nul', 'PC-SSH-NUL')

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.match(res.body, /"type":"end"/)
  const rows = await execRows(script.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'success', `sortie : ${rows[0].output}`)
  assert.equal(rows[0].output, 'ok')
})

test('POST /:id/exec — échec avant la connexion (clé SSH absente) : ligne en error, réponse terminée', { skip: SKIP, timeout: 15000 }, async (t) => {
  withEnv(t, { SSH_PRIVATE_KEY_B64: undefined })
  const token = await adminToken('oid-sc-exec-ssh-nokey')
  const script = await seedScript({ name: 'SSH no key' })
  const { group } = await groupWithDevice('G-exec-ssh-nokey', 'PC-SSH-NOKEY')

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.match(res.body, /"type":"end"/)
  const rows = await execRows(script.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'error')
  assert.match(rows[0].output, /SSH_PRIVATE_KEY_B64/)
})

// ip_netbird est remonté par l'agent : l'exécution SSH ne doit viser qu'une
// IP littérale, jamais un nom d'hôte (redirection de la session et de la clé
// SSH d'administration vers une machine contrôlée par l'agent).
async function groupWithIps(name, devices) {
  const group = await seedGroup({ name })
  const seeded = []
  for (const { hostname, ip } of devices) {
    const d = await seedDevice(db, { hostname, ipNetbird: ip })
    await db.query(`INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1, $2, 'test')`, [group.id, d.id])
    seeded.push(d)
  }
  return { group, devices: seeded }
}

test('POST /:id/exec — ip_netbird qui n\'est pas une IP (nom d\'hôte) → 400, aucune exécution ni connexion', { skip: SKIP, timeout: 15000 }, async () => {
  const token = await adminToken('oid-sc-exec-bad-ip')
  const script = await seedScript({ name: 'SSH bad ip' })
  const { group } = await groupWithIps('G-exec-bad-ip', [{ hostname: 'PC-BAD-IP', ip: 'localhost' }])

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /invalide/)
  assert.equal((await execRows(script.id)).length, 0)
})

test('POST /:id/exec — groupe mixte : seul le poste à IP littérale est exécuté', { skip: SKIP, timeout: 15000 }, async (t) => {
  const port = await fakeSshServer(t, { output: 'ok' })
  const clientKey = ed25519KeyPair()
  withEnv(t, { SSH_PORT: String(port), SSH_USER: 'opale', SSH_PRIVATE_KEY_B64: Buffer.from(clientKey.private).toString('base64') })
  const token = await adminToken('oid-sc-exec-mixed-ip')
  const script = await seedScript({ name: 'SSH mixed ip' })
  // « localhost » joindrait aussi le faux serveur : seule la validation
  // empêche de l'utiliser comme cible.
  const { group, devices } = await groupWithIps('G-exec-mixed-ip', [
    { hostname: 'PC-GOOD-IP', ip: '127.0.0.1' },
    { hostname: 'PC-HOSTNAME', ip: 'localhost' },
  ])

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /"type":"end"/)
  const { rows } = await db.query(
    `SELECT device_id, status FROM script_executions WHERE script_id = $1`, [script.id])
  assert.deepEqual(rows.map(r => r.device_id), [devices[0].id], 'seul le poste à IP littérale')
  assert.equal(rows[0].status, 'success')
})

// Clé d'hôte SSH (TOFU) : la cible vient d'une IP remontée par l'agent. Sans
// vérification, quiconque répond à cette IP recevait le script et renvoyait
// une sortie arbitraire.
async function waitForHostKey(deviceId) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await db.query(`SELECT ssh_host_key_fp FROM devices WHERE id = $1`, [deviceId])
    if (rows[0]?.ssh_host_key_fp) return rows[0].ssh_host_key_fp
    await new Promise(r => setTimeout(r, 20))
  }
  return null
}

test('POST /:id/exec — clé d\'hôte SSH apprise au premier contact, puis toute autre clé refusée avant exécution', { skip: SKIP, timeout: 20000 }, async (t) => {
  const legit = await startFakeSshServer(t, { output: 'ok' })
  sshClientEnv(t, legit.port)
  const token = await adminToken('oid-sc-exec-hostkey')
  const script = await seedScript({ name: 'SSH host key' })
  const { group, devices: [device] } = await groupWithIps('G-exec-hostkey', [{ hostname: 'PC-HOSTKEY', ip: '127.0.0.1' }])
  const exec = () => fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })

  // 1er contact : exécution normale, empreinte mémorisée.
  const first = await exec()
  assert.match(first.body, /"type":"end"/)
  const learned = await waitForHostKey(device.id)
  assert.ok(learned, 'empreinte apprise au premier contact')
  assert.equal(legit.state.execs, 1)

  // Même IP, autre clé d'hôte (imposteur ou poste réinstallé) : refus avant
  // authentification, rien n'est exécuté, l'empreinte reste celle apprise.
  const impostor = await startFakeSshServer(t, { output: 'sortie falsifiée' })
  process.env.SSH_PORT = String(impostor.port)
  const second = await exec()
  assert.match(second.body, /"type":"end"/)
  assert.equal(impostor.state.execs, 0, 'aucune commande reçue par l\'imposteur')
  const { rows } = await db.query(
    `SELECT status, output FROM script_executions WHERE script_id = $1 ORDER BY queued_at DESC LIMIT 1`, [script.id])
  assert.equal(rows[0].status, 'error')
  assert.match(rows[0].output, /Clé d'hôte SSH inattendue/)
  const { rows: [dev] } = await db.query(`SELECT ssh_host_key_fp FROM devices WHERE id = $1`, [device.id])
  assert.equal(dev.ssh_host_key_fp, learned, 'empreinte non écrasée')
  const { rows: audit } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'ssh_host_key_mismatch' AND target = $1`, [device.id])
  assert.equal(audit.length, 1)
  assert.equal(audit[0].details.expected_fingerprint, learned)
})

test('POST /:id/exec — hôte qui raccroche après authentification : exécution en erreur, API intacte', { skip: SKIP, timeout: 20000 }, async (t) => {
  // Sans garde, conn.exec() levait « Not connected » dans un gestionnaire
  // asynchrone : rejet non géré, donc arrêt de l'API, et réponse SSE jamais
  // terminée.
  const rejections = trackUnhandledRejections(t)
  const server = await startFakeSshServer(t, { endOnReady: true })
  sshClientEnv(t, server.port)
  const token = await adminToken('oid-sc-exec-hangup')
  const script = await seedScript({ name: 'SSH hangup' })
  const { group } = await groupWithIps('G-exec-hangup', [{ hostname: 'PC-HANGUP', ip: '127.0.0.1' }])

  const res = await fastify.inject({
    method: 'POST', url: `/api/scripts/${script.id}/exec`,
    headers: { authorization: `Bearer ${token}` },
    payload: { native_group_id: group.id },
  })
  assert.match(res.body, /"type":"end"/)
  const { rows } = await db.query(
    `SELECT status FROM script_executions WHERE script_id = $1`, [script.id])
  assert.equal(rows[0].status, 'error')
  assert.equal(server.state.execs, 0)
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(rejections, [])
})
