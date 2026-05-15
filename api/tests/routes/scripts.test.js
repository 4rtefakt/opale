// routes/scripts.js — couverture des chemins critiques :
// - CRUD scripts (list, create, get, update, delete)
// - POST /:id/run (queue agent)
// - GET /executions/device/:deviceId
// - POST /:id/exec (validation + chemins 400/404, pas l'exécution SSH réelle)
//
// L'exécution SSH réelle n'est pas testée (requiert un agent en ligne).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import scriptsRoute from '../../modules/inventory/routes/scripts.js'

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
