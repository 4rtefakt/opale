// routes/native-groups.js : CRUD groupes natifs + ACL admin + audit log.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import nativeGroupsRoute from '../../modules/groups/routes/native-groups.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

// Stub Graph partagé — les tests Entra réassignent les fonctions avant appel.
const graph = {
  getGroupDeviceHostnames: async () => [],
  getGroupUserIds: async () => [],
}

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    decorators: { graph },
    routes: async (f) => {
      await f.register(nativeGroupsRoute, { prefix: '/api/groups' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-grp-admin', name = 'Admin Groupes') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId = 'oid-grp-user', name = 'User Groupes') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function createGroup(token, body) {
  return fastify.inject({
    method: 'POST', url: '/api/groups/',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  })
}

function auditRows(action) {
  return db.query(
    'SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at DESC LIMIT 5',
    [action]
  ).then(r => r.rows)
}

// ─── ACL ─────────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/groups/' })
  assert.equal(res.statusCode, 401)
})

test('GET / — non-admin → 403', { skip: SKIP }, async () => {
  const token = await userToken('oid-grp-user-acl')
  const res = await fastify.inject({
    method: 'GET', url: '/api/groups/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── POST / — création ───────────────────────────────────────────────────────

test('POST / — name manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-create-400')
  const res = await createGroup(token, { color: 'blue' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /name/)
})

test('POST / — couleur invalide → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-create-color')
  const res = await createGroup(token, { name: 'G-couleur', color: 'rainbow' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /[Cc]ouleur/)
})

test('POST / — création réussie → 201 + audit log', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-create-ok')
  const res = await createGroup(token, { name: 'Groupe Alpha', color: 'blue', description: 'desc' })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.id)
  assert.equal(body.name, 'Groupe Alpha')
  assert.equal(body.color, 'blue')
  assert.equal(body.source, 'native')

  const logs = await auditRows('group_created')
  assert.ok(logs.some(l => l.target === 'Groupe Alpha'))
})

test('POST / — nom dupliqué → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-dup')
  await createGroup(token, { name: 'Groupe Doublon' })
  const res = await createGroup(token, { name: 'Groupe Doublon' })
  assert.equal(res.statusCode, 409)
})

// ─── GET / — liste ───────────────────────────────────────────────────────────

test('GET / — retourne les groupes avec member_count', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-list')
  await createGroup(token, { name: 'Groupe Liste' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/groups/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const groups = res.json()
  assert.ok(Array.isArray(groups))
  const g = groups.find(x => x.name === 'Groupe Liste')
  assert.ok(g)
  assert.equal(typeof g.member_count, 'number')
})

// ─── GET /:id — détail ───────────────────────────────────────────────────────

test('GET /:id — groupe inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-get-404')
  const res = await fastify.inject({
    method: 'GET', url: '/api/groups/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — retourne membres devices + users', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-detail')
  const device = await seedDevice(db, { hostname: 'PC-DETAIL' })

  const created = (await createGroup(token, { name: 'Groupe Détail' })).json()

  // Ajouter un device
  await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  // Ajouter un user (référence molle)
  await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { user_id: 'oid-user-member' },
  })

  const res = await fastify.inject({
    method: 'GET', url: `/api/groups/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.devices.length, 1)
  assert.equal(body.devices[0].hostname, 'PC-DETAIL')
  assert.equal(body.users.length, 1)
  assert.equal(body.users[0].user_id, 'oid-user-member')
})

// ─── PATCH /:id — update ─────────────────────────────────────────────────────

test('PATCH /:id — name vide → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-patch-400')
  const created = (await createGroup(token, { name: 'Groupe Patch 400' })).json()
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/groups/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: '  ' },
  })
  assert.equal(res.statusCode, 400)
})

test('PATCH /:id — mise à jour réussie + audit log', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-patch-ok')
  const created = (await createGroup(token, { name: 'Groupe Patch', color: 'blue' })).json()

  const res = await fastify.inject({
    method: 'PATCH', url: `/api/groups/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { color: 'amber' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().color, 'amber')
  assert.equal(res.json().name, 'Groupe Patch')

  const logs = await auditRows('group_updated')
  assert.ok(logs.some(l => l.target === 'Groupe Patch'))
})

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

test('DELETE /:id — supprime groupe + membres (CASCADE) + audit log', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-del')
  const device = await seedDevice(db, { hostname: 'PC-DEL-CASCADE' })
  const created = (await createGroup(token, { name: 'Groupe Delete' })).json()

  await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/groups/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 204)

  // Le groupe n'existe plus
  const check = await fastify.inject({
    method: 'GET', url: `/api/groups/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(check.statusCode, 404)

  // Les membres ont disparu (CASCADE)
  const { rows } = await db.query(
    'SELECT id FROM group_members WHERE group_id = $1', [created.id]
  )
  assert.equal(rows.length, 0)

  const logs = await auditRows('group_deleted')
  assert.ok(logs.some(l => l.target === 'Groupe Delete'))
})

test('DELETE /:id — groupe inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-del-404')
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/groups/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── POST /:id/members ───────────────────────────────────────────────────────

test('POST /:id/members — ni device ni user → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-400')
  const created = (await createGroup(token, { name: 'Groupe Mem 400' })).json()
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

test('POST /:id/members — device_id ET user_id → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-both')
  const created = (await createGroup(token, { name: 'Groupe Mem Both' })).json()
  const device = await seedDevice(db, { hostname: 'PC-MEM-BOTH' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id, user_id: 'oid-x' },
  })
  assert.equal(res.statusCode, 400)
})

test('POST /:id/members — device inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-nodev')
  const created = (await createGroup(token, { name: 'Groupe Mem NoDevice' })).json()
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: '00000000-0000-0000-0000-000000000000' },
  })
  assert.equal(res.statusCode, 404)
})

test('POST /:id/members — ajout device + audit log', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-ok')
  const device = await seedDevice(db, { hostname: 'PC-MEM-OK' })
  const created = (await createGroup(token, { name: 'Groupe Mem OK' })).json()

  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().device_id, device.id)

  const logs = await auditRows('group_member_added')
  assert.ok(logs.some(l => l.target === 'Groupe Mem OK'))
})

test('POST /:id/members — doublon device → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-dup')
  const device = await seedDevice(db, { hostname: 'PC-MEM-DUP' })
  const created = (await createGroup(token, { name: 'Groupe Mem Dup' })).json()

  await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  assert.equal(res.statusCode, 409)
})

// ─── DELETE /:id/members/:mid ─────────────────────────────────────────────────

test('DELETE /:id/members/:mid — retire membre + audit log', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-rm')
  const device = await seedDevice(db, { hostname: 'PC-MEM-RM' })
  const created = (await createGroup(token, { name: 'Groupe Mem RM' })).json()

  const addRes = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { device_id: device.id },
  })
  const mid = addRes.json().id

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/groups/${created.id}/members/${mid}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 204)

  const logs = await auditRows('group_member_removed')
  assert.ok(logs.some(l => l.target === 'Groupe Mem RM'))
})

test('DELETE /:id/members/:mid — membre inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-grp-mem-rm-404')
  const created = (await createGroup(token, { name: 'Groupe Mem RM 404' })).json()
  const res = await fastify.inject({
    method: 'DELETE',
    url: `/api/groups/${created.id}/members/00000000-0000-0000-0000-000000000000`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── POST /import-from-entra ──────────────────────────────────────────────────

test('POST /import-from-entra — entra_group_id manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-entra-imp-400a')
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'G-import', color: 'blue' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /entra_group_id/)
})

test('POST /import-from-entra — name manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-entra-imp-400b')
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-400b', color: 'blue' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /name/)
})

test('POST /import-from-entra — Graph fail → 502', { skip: SKIP }, async () => {
  graph.getGroupDeviceHostnames = async () => { throw new Error('Graph 503') }
  graph.getGroupUserIds         = async () => []
  const token = await adminToken('oid-entra-imp-502')
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-502', name: 'G-graph-fail', color: 'blue' },
  })
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /Graph/)
  graph.getGroupDeviceHostnames = async () => []
})

test('POST /import-from-entra — succès : devices + users importés + audit log', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-ENTRA-IMPORT' })
  graph.getGroupDeviceHostnames = async () => [device.hostname]
  graph.getGroupUserIds         = async () => ['entra-uid-import-1']
  const token = await adminToken('oid-entra-imp-ok')
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-import-ok', name: 'G-import-ok', color: 'green' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.source, 'entra')
  assert.equal(body.devices_imported, 1)
  assert.equal(body.users_imported, 1)
  assert.equal(body.unmatched, 0)

  // Membres insérés en DB
  const { rows } = await db.query('SELECT * FROM group_members WHERE group_id = $1', [body.id])
  assert.equal(rows.length, 2)

  const logs = await auditRows('group_imported_from_entra')
  assert.ok(logs.some(l => l.target === 'G-import-ok'))

  graph.getGroupDeviceHostnames = async () => []
  graph.getGroupUserIds         = async () => []
})

test('POST /import-from-entra — entra_group_id déjà importé → 409', { skip: SKIP }, async () => {
  graph.getGroupDeviceHostnames = async () => []
  graph.getGroupUserIds         = async () => []
  const token = await adminToken('oid-entra-imp-dup')
  // Premier import
  await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-dup', name: 'G-dup-entra-1', color: 'slate' },
  })
  // Deuxième import du même groupe Entra
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-dup', name: 'G-dup-entra-2', color: 'slate' },
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /G-dup-entra-1/)
})

// ─── POST /:id/sync-from-entra ────────────────────────────────────────────────

test('POST /:id/sync-from-entra — groupe inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-entra-sync-404')
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/00000000-0000-0000-0000-000000000000/sync-from-entra',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('POST /:id/sync-from-entra — groupe sans entra_group_id → 409', { skip: SKIP }, async () => {
  const token = await adminToken('oid-entra-sync-409')
  const created = (await createGroup(token, { name: 'G-sync-native', color: 'slate' })).json()
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/sync-from-entra`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /Entra/)
})

test('POST /:id/sync-from-entra — Graph fail → 502', { skip: SKIP }, async () => {
  graph.getGroupDeviceHostnames = async () => []
  graph.getGroupUserIds         = async () => []
  const token = await adminToken('oid-entra-sync-502')
  // Créer un groupe lié à Entra via import
  const imported = (await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-sync-502', name: 'G-sync-fail', color: 'slate' },
  })).json()

  graph.getGroupDeviceHostnames = async () => { throw new Error('Graph timeout') }
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${imported.id}/sync-from-entra`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /Graph/)
  graph.getGroupDeviceHostnames = async () => []
})

test('POST /:id/sync-from-entra — full-replace correct + audit log', { skip: SKIP }, async () => {
  const deviceA = await seedDevice(db, { hostname: 'PC-SYNC-A' })
  const deviceB = await seedDevice(db, { hostname: 'PC-SYNC-B' })
  graph.getGroupDeviceHostnames = async () => [deviceA.hostname]
  graph.getGroupUserIds         = async () => ['uid-sync-old']
  const token = await adminToken('oid-entra-sync-ok')

  // Import initial : deviceA + uid-sync-old
  const imported = (await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-sync-ok', name: 'G-sync-ok', color: 'blue' },
  })).json()

  // Sync avec deviceB uniquement + uid-sync-new
  graph.getGroupDeviceHostnames = async () => [deviceB.hostname]
  graph.getGroupUserIds         = async () => ['uid-sync-new']
  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${imported.id}/sync-from-entra`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.devices_synced, 1)
  assert.equal(body.users_synced, 1)

  // Vérifier que les anciens membres sont remplacés
  const { rows } = await db.query('SELECT device_id, user_id FROM group_members WHERE group_id = $1', [imported.id])
  assert.equal(rows.length, 2)
  assert.ok(rows.some(r => r.device_id === deviceB.id))
  assert.ok(rows.some(r => r.user_id === 'uid-sync-new'))
  assert.ok(!rows.some(r => r.device_id === deviceA.id))
  assert.ok(!rows.some(r => r.user_id === 'uid-sync-old'))

  const logs = await auditRows('group_synced_from_entra')
  assert.ok(logs.some(l => l.target === 'G-sync-ok'))

  graph.getGroupDeviceHostnames = async () => []
  graph.getGroupUserIds         = async () => []
})

// ─── POST /:id/detach-entra ───────────────────────────────────────────────────

test('POST /:id/detach-entra — groupe inexistant ou déjà détaché → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-entra-detach-404')
  // Groupe inexistant
  const res1 = await fastify.inject({
    method: 'POST', url: '/api/groups/00000000-0000-0000-0000-000000000000/detach-entra',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res1.statusCode, 404)

  // Groupe natif sans entra_group_id
  const created = (await createGroup(token, { name: 'G-detach-native', color: 'slate' })).json()
  const res2 = await fastify.inject({
    method: 'POST', url: `/api/groups/${created.id}/detach-entra`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res2.statusCode, 404)
})

test('POST /:id/detach-entra — succès : source native, entra_group_id NULL + audit log', { skip: SKIP }, async () => {
  graph.getGroupDeviceHostnames = async () => []
  graph.getGroupUserIds         = async () => []
  const token = await adminToken('oid-entra-detach-ok')

  // Créer un groupe Entra importé
  const imported = (await fastify.inject({
    method: 'POST', url: '/api/groups/import-from-entra',
    headers: { authorization: `Bearer ${token}` },
    payload: { entra_group_id: 'entra-gid-detach-ok', name: 'G-detach-ok', color: 'violet' },
  })).json()

  const res = await fastify.inject({
    method: 'POST', url: `/api/groups/${imported.id}/detach-entra`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.ok(res.json().ok)

  // Vérifier en DB : source='native', entra_group_id IS NULL
  const { rows: [g] } = await db.query('SELECT source, entra_group_id FROM groups WHERE id = $1', [imported.id])
  assert.equal(g.source, 'native')
  assert.equal(g.entra_group_id, null)

  const logs = await auditRows('group_detached_from_entra')
  assert.ok(logs.some(l => l.target === 'G-detach-ok'))
})
