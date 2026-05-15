// routes/packages.js : CRUD packages + approve + deploy (tous scopes DB) + cancel-all + jobs/cancel.
//
// scope='group' (Entra) exclut des tests : la fonction getGroupDeviceHostnames
// est importée directement (pas via fastify.graph), impossible à mocker proprement
// sans module mock. Les scopes device, native_group, user, all sont couverts ici.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { insertPackage, insertDeploymentJob, insertDeployment } from '../fixtures/packages.js'

import packagesRoute from '../../modules/inventory/routes/packages.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

// Stub winget : non prêt par défaut — pas de fetch réseau en test.
const wingetStub = { ready: () => false, search: () => ({ results: [] }) }

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    decorators: { winget: wingetStub },
    routes: async (f) => {
      await f.register(packagesRoute, { prefix: '/api/packages' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-pkg-admin', name = 'Pkg Admin') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId = 'oid-pkg-user', name = 'Pkg User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// Crée un device avec assigned_user_id.
async function seedDeviceForUser(db, hostname, userEntraId) {
  const r = await db.query(
    `INSERT INTO devices (hostname, assigned_user_id, last_seen)
     VALUES ($1, $2, now()) RETURNING id, hostname`,
    [hostname, userEntraId]
  )
  return r.rows[0]
}

// Crée un groupe natif et retourne son id.
async function insertNativeGroup(db, name = 'Groupe Test') {
  const r = await db.query(
    `INSERT INTO groups (name) VALUES ($1) RETURNING id`,
    [name]
  )
  return r.rows[0].id
}

// Ajoute un device comme membre d'un groupe natif.
async function addDeviceToGroup(db, groupId, deviceId) {
  await db.query(
    `INSERT INTO group_members (group_id, device_id) VALUES ($1, $2)`,
    [groupId, deviceId]
  )
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET /api/packages — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/packages' })
  assert.equal(res.statusCode, 401)
})

test('POST /api/packages — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/packages',
    payload: { name: 'X', type: 'winget', winget_id: 'X.X' },
  })
  assert.equal(res.statusCode, 401)
})

// ─── POST / — création ────────────────────────────────────────────────────────

test('POST /api/packages — non-admin peut créer (pas requireAdmin)', { skip: SKIP }, async () => {
  const token = await userToken('oid-pkg-create-user')
  const res = await fastify.inject({
    method: 'POST', url: '/api/packages',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Mon App', type: 'winget', winget_id: 'My.App' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.name, 'Mon App')
  assert.equal(body.status, 'draft')
  assert.ok(body.id, 'id doit être présent')
})

test('POST /api/packages — name manquant → 400', { skip: SKIP }, async () => {
  const token = await userToken('oid-pkg-noname-user')
  const res = await fastify.inject({
    method: 'POST', url: '/api/packages',
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'winget', winget_id: 'X.X' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /name/)
})

test('POST /api/packages — type=winget sans winget_id → 400', { skip: SKIP }, async () => {
  const token = await userToken('oid-pkg-nowinget-user')
  const res = await fastify.inject({
    method: 'POST', url: '/api/packages',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'App Sans Id', type: 'winget' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /winget_id/)
})

// ─── GET / — liste ────────────────────────────────────────────────────────────

test('GET /api/packages — admin reçoit la liste des packages', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-list-admin')
  await insertPackage(db, { name: 'Pkg For List', createdBy: 'oid-pkg-list-admin' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/packages',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(Array.isArray(rows))
  assert.ok(rows.length >= 1)
  // Chaque row doit avoir les champs de couverture
  const pkg = rows.find(r => r.name === 'Pkg For List')
  assert.ok(pkg, 'le package créé doit être dans la liste')
  assert.ok('pending_count' in pkg, 'pending_count doit être présent')
  assert.ok('success_count' in pkg, 'success_count doit être présent')
})

// ─── POST /:id/approve ────────────────────────────────────────────────────────

test('POST /:id/approve — non-admin → 403', { skip: SKIP }, async () => {
  const adminTk = await adminToken('oid-pkg-approv-setup')
  const userTk = await userToken('oid-pkg-approv-user')
  const pkg = await insertPackage(db, { name: 'Pkg Approve Test', status: 'draft' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/approve`,
    headers: { authorization: `Bearer ${userTk}` },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /:id/approve — draft → approved', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-approv-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Draft Approve', status: 'draft' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/approve`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'approved')
  assert.ok(res.json().approved_by, 'approved_by doit être renseigné')
})

test('POST /:id/approve — déjà approuvé → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-approv2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Already Approved', status: 'approved' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/approve`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 409)
})

// ─── POST /:id/deploy — scope=device ─────────────────────────────────────────

test('POST /:id/deploy — package draft → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-deploy-draft-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Draft Deploy', status: 'draft' })
  const dev = await seedDevice(db, { hostname: 'PC-DRAFTDEP' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'device', device_ids: [dev.id] },
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /approuvé/)
})

test('POST /:id/deploy — scope=device, 1 device → 1 deployment créé', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-deploy1-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Device Deploy', createdBy: 'oid-pkg-deploy1-admin' })
  const dev = await seedDevice(db, { hostname: 'PC-DEPLOY1' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'device', device_ids: [dev.id] },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.queued, 1)
  assert.equal(body.total, 1)

  const { rows } = await db.query(
    'SELECT * FROM deployments WHERE package_id = $1 AND device_id = $2',
    [pkg.id, dev.id]
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'pending')
})

test('POST /:id/deploy — scope=device sans device_ids → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-deploy-nodev-admin')
  const pkg = await insertPackage(db, { name: 'Pkg No Dev Deploy' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'device', device_ids: [] },
  })
  assert.equal(res.statusCode, 400)
})

// ─── POST /:id/deploy — scope=native_group ───────────────────────────────────

test('POST /:id/deploy — scope=native_group groupe vide → 400', { skip: SKIP }, async () => {
  // Le code retourne 400 pour un groupe natif vide (pas de job créé).
  // Cohérent avec la garde ligne 312 : "Groupe natif vide ou ne contient aucun poste".
  const token = await adminToken('oid-pkg-ng-empty-admin')
  const pkg = await insertPackage(db, { name: 'Pkg NG Empty' })
  const groupId = await insertNativeGroup(db, 'Groupe Vide')

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'native_group', native_group_id: groupId },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /vide/)
})

test('POST /:id/deploy — scope=native_group avec 2 devices → 2 deployments', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-ng2-admin')
  const pkg = await insertPackage(db, { name: 'Pkg NG 2 Devices' })
  const groupId = await insertNativeGroup(db, 'Groupe 2 Devices')
  const d1 = await seedDevice(db, { hostname: 'PC-NG2-1' })
  const d2 = await seedDevice(db, { hostname: 'PC-NG2-2' })
  await addDeviceToGroup(db, groupId, d1.id)
  await addDeviceToGroup(db, groupId, d2.id)

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'native_group', native_group_id: groupId },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.queued, 2)
  assert.equal(body.total, 2)
  assert.ok(body.job_id, 'job_id doit être présent pour scope != device')

  const { rows } = await db.query(
    'SELECT status FROM deployments WHERE package_id = $1 ORDER BY queued_at',
    [pkg.id]
  )
  assert.equal(rows.length, 2)
  for (const r of rows) assert.equal(r.status, 'pending')
})

// ─── POST /:id/deploy — scope=user ───────────────────────────────────────────

test('POST /:id/deploy — scope=user, 1 device assigné → 1 deployment', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-user-admin')
  const userEntraId = 'oid-pkg-assigned-user'
  await seedNonAdmin(db, { entraId: userEntraId, displayName: 'User Assigné', email: 'ua@x' })

  const pkg = await insertPackage(db, { name: 'Pkg User Deploy' })
  const dev = await seedDeviceForUser(db, 'PC-USERASSIGNED', userEntraId)

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'user', user_entra_id: userEntraId },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.queued, 1)
  assert.ok(body.job_id, 'job_id doit être présent pour scope=user')
})

test('POST /:id/deploy — scope=user sans device assigné → queued=0 mais 201 + job créé', { skip: SKIP }, async () => {
  // Un user sans devices = job actif qui attendra le premier PC assigné.
  const token = await adminToken('oid-pkg-user0-admin')
  const userEntraId = 'oid-pkg-nodevice-user'
  const pkg = await insertPackage(db, { name: 'Pkg User No Device' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'user', user_entra_id: userEntraId },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.queued, 0)
  assert.ok(body.job_id, 'job_id doit être présent même avec 0 devices')
})

// ─── POST /:id/deploy — scope=all ────────────────────────────────────────────

test('POST /:id/deploy — scope=all, ≤10 devices → queued direct (201)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-all-admin')
  const pkg = await insertPackage(db, { name: 'Pkg All Deploy' })
  // 3 devices suffisent pour scope=all sans confirmation
  for (let i = 0; i < 3; i++) {
    await seedDevice(db, { hostname: `PC-ALL-${i}` })
  }

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'all' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.queued >= 3, 'au moins 3 devices déployés')
  assert.ok(body.job_id, 'job_id doit être présent pour scope=all')
})

// ─── Garde de confirmation : > 10 devices ─────────────────────────────────────

test('POST /:id/deploy — scope=device, >10 devices sans confirmed → requires_confirmation', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-confirm-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Confirm Guard' })
  const deviceIds = []
  for (let i = 0; i < 12; i++) {
    const d = await seedDevice(db, { hostname: `PC-CONFIRM-${i}` })
    deviceIds.push(d.id)
  }

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'device', device_ids: deviceIds },
  })
  // 200 intentionnel (pas 400) — cf. commentaire dans le code
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.requires_confirmation, true)
  assert.equal(body.count, 12)
})

test('POST /:id/deploy — scope=device, >10 devices avec confirmed=true → queued', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-confirmed-admin')
  const pkg = await insertPackage(db, { name: 'Pkg Confirmed Deploy' })
  const deviceIds = []
  for (let i = 0; i < 11; i++) {
    const d = await seedDevice(db, { hostname: `PC-CONFIRMED-${i}` })
    deviceIds.push(d.id)
  }

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/deploy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scope: 'device', device_ids: deviceIds, confirmed: true },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().queued, 11)
})

// ─── POST /:id/cancel-all ─────────────────────────────────────────────────────

test('POST /:id/cancel-all — 3 pending → tous cancelled + job stoppé', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-cancelall-admin')
  const pkg = await insertPackage(db, { name: 'Pkg CancelAll' })
  const job = await insertDeploymentJob(db, { packageId: pkg.id, scope: 'all' })

  const devs = await Promise.all([
    seedDevice(db, { hostname: 'PC-CA-1' }),
    seedDevice(db, { hostname: 'PC-CA-2' }),
    seedDevice(db, { hostname: 'PC-CA-3' }),
  ])
  await Promise.all(
    devs.map(d => insertDeployment(db, { packageId: pkg.id, deviceId: d.id, jobId: job.id }))
  )

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/${pkg.id}/cancel-all`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.cancelled_deployments, 3)
  assert.equal(body.cancelled_jobs, 1)

  // Vérifier en base
  const { rows } = await db.query(
    'SELECT status FROM deployments WHERE package_id = $1', [pkg.id]
  )
  for (const r of rows) assert.equal(r.status, 'cancelled')

  const { rows: [j] } = await db.query(
    'SELECT status FROM deployment_jobs WHERE id = $1', [job.id]
  )
  assert.equal(j.status, 'cancelled')
})

// ─── POST /jobs/:jobId/cancel ─────────────────────────────────────────────────

test('POST /jobs/:jobId/cancel — job actif → cancelled', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-jobcancel-admin')
  const pkg = await insertPackage(db, { name: 'Pkg JobCancel' })
  const job = await insertDeploymentJob(db, { packageId: pkg.id, scope: 'all' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/packages/jobs/${job.id}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'cancelled')

  const { rows: [j] } = await db.query(
    'SELECT status FROM deployment_jobs WHERE id = $1', [job.id]
  )
  assert.equal(j.status, 'cancelled')
})

test('POST /jobs/:jobId/cancel — job introuvable → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-pkg-jobcancel2-admin')
  const res = await fastify.inject({
    method: 'POST', url: '/api/packages/jobs/00000000-0000-0000-0000-000000000000/cancel',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})
