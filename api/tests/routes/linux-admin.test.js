// Routes admin du module linux (docs/linux-fleet-design.md §5) hors parcours
// d'approbation unitaire (cf. linux-enroll-flow.test.js) : garde
// authenticate + requireAdmin sur chaque route, lots (approve-bulk,
// reject-bulk), rejet unitaire, pré-inscriptions, révocation d'une clé.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { newAgent, enroll } from '../helpers/linux-agent.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import linux from '../../modules/linux/index.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const NIL = '00000000-0000-4000-8000-000000000000'

let db, release, app, jwt, admin, user

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  app = await buildApp({ db, jwks: jwt.jwks, routes: f => linux.register(f) })
  const a = await seedAdmin(db, { entraId: 'oid-lxa-admin', displayName: 'Admin Lx', email: 'admin-lx@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  const u = await seedNonAdmin(db, { entraId: 'oid-lxa-user', displayName: 'Jean Dupont', email: 'J.Dupont@Example.org' })
  user = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }
})

after(async () => {
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
})

const api = (method, url, { headers = admin, payload } = {}) => app.inject({ method, url, headers, payload })

async function pendingKey(serial) {
  const agent = newAgent({ serial })
  const res = await enroll(app, agent, { ip: '203.0.113.200' })
  assert.equal(res.statusCode, 202, res.body)
  const { rows: [row] } = await db.query('SELECT * FROM linux_device_keys WHERE key_fingerprint = $1', [agent.fingerprint])
  return row
}

async function keyStatus(id) {
  const { rows: [row] } = await db.query('SELECT status, device_id FROM linux_device_keys WHERE id = $1', [id])
  return row
}

test('chaque route admin : sans Bearer → 401, non-admin → 403 (rien n’est lu ni écrit)', { skip: SKIP }, async () => {
  const routes = [
    ['GET', '/api/linux/enrollments'],
    ['GET', '/api/linux/enrollments/count'],
    ['POST', `/api/linux/enrollments/${NIL}/approve`, { profile: 'field', ring: 'pilot' }],
    ['POST', `/api/linux/enrollments/${NIL}/reject`, {}],
    ['POST', '/api/linux/enrollments/approve-bulk', { ids: [NIL], profile: 'field', ring: 'pilot' }],
    ['POST', '/api/linux/enrollments/reject-bulk', { ids: [NIL] }],
    ['GET', '/api/linux/preregistrations'],
    ['POST', '/api/linux/preregistrations', { rows: [{ serial: 'SN-AUTH', profile: 'field', ring: 'pilot' }] }],
    ['POST', '/api/linux/preregistrations/from-devices', { device_ids: [NIL], profile: 'field', ring: 'pilot' }],
    ['DELETE', `/api/linux/preregistrations/${NIL}`],
    ['POST', `/api/linux/devices/${NIL}/revoke`, { reason: 'Poste volé' }],
  ]
  for (const [method, url, payload] of routes) {
    assert.equal((await api(method, url, { headers: {}, payload })).statusCode, 401, `${method} ${url} sans Bearer`)
    assert.equal((await api(method, url, { headers: user, payload })).statusCode, 403, `${method} ${url} non-admin`)
  }
  assert.equal((await db.query("SELECT 1 FROM linux_preregistrations WHERE serial = 'SN-AUTH'")).rowCount, 0)
})

test('GET /enrollments — filtre par statut, pagination, total ; corps hors schéma → 400', { skip: SKIP }, async () => {
  const a = await pendingKey('SN-LIST-A')
  const b = await pendingKey('SN-LIST-B')
  await api('POST', `/api/linux/enrollments/${b.id}/reject`, { payload: {} })
  const pending = await api('GET', '/api/linux/enrollments')
  assert.equal(pending.statusCode, 200, pending.body)
  assert.ok(pending.json().rows.some(r => r.id === a.id))
  assert.ok(!pending.json().rows.some(r => r.id === b.id))
  const rejected = await api('GET', '/api/linux/enrollments?status=rejected')
  assert.deepEqual(rejected.json().rows.map(r => r.id), [b.id])
  assert.equal(rejected.json().total, 1)
  const page = await api('GET', '/api/linux/enrollments?limit=1&offset=0')
  assert.equal(page.json().rows.length, 1)
  assert.equal(page.json().total, pending.json().total)
  assert.equal((await api('GET', '/api/linux/enrollments?status=bogus')).statusCode, 400)
  assert.equal((await api('GET', '/api/linux/enrollments?limit=0')).statusCode, 400)
})

test('POST /enrollments/:id/reject — sans corps comme avec motif ; NOT_PENDING ensuite ; inconnu 404', { skip: SKIP }, async () => {
  const noBody = await pendingKey('SN-REJ-NOBODY')
  const res = await app.inject({ method: 'POST', url: `/api/linux/enrollments/${noBody.id}/reject`, headers: admin })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().status, 'rejected')
  assert.equal(res.json().code, noBody.key_fingerprint.slice(0, 8))
  assert.equal(res.json().conflict, null)
  const withReason = await pendingKey('SN-REJ-REASON')
  const reasoned = await api('POST', `/api/linux/enrollments/${withReason.id}/reject`, { payload: { reason: 'inconnu' } })
  assert.equal(reasoned.statusCode, 200, reasoned.body)
  const { rows: [audit] } = await db.query("SELECT details FROM audit_logs WHERE action = 'linux_device_rejected' AND details->>'key_id' = $1", [withReason.id])
  assert.equal(audit.details.reason, 'inconnu')
  const again = await api('POST', `/api/linux/enrollments/${withReason.id}/reject`, { payload: {} })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'NOT_PENDING')
  assert.equal((await api('POST', `/api/linux/enrollments/${NIL}/reject`, { payload: {} })).statusCode, 404)
  assert.equal((await api('POST', `/api/linux/enrollments/${withReason.id}/reject`, { payload: { reason: 'x'.repeat(501) } })).statusCode, 400)
})

test('POST /enrollments/approve-bulk — matériels neufs approuvés, conflit et inconnu signalés (BulkResult)', { skip: SKIP }, async () => {
  const a = await pendingKey('SN-BULK-A')
  const b = await pendingKey('SN-BULK-B')
  await seedDevice(db, { hostname: 'PC-BULK-WIN', serial: 'SN-BULK-WIN' })
  const conflict = await pendingKey('SN-BULK-WIN')
  const res = await api('POST', '/api/linux/enrollments/approve-bulk', { payload: { ids: [a.id, b.id, conflict.id, NIL], profile: 'field', ring: 'pilot' } })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, 2)
  assert.equal(body.skipped, 2)
  assert.deepEqual(Object.fromEntries(body.errors.map(e => [e.id, e.code])), { [conflict.id]: 'CONFLICT', [NIL]: 'NOT_FOUND' })
  for (const key of [a, b]) {
    const stored = await keyStatus(key.id)
    assert.equal(stored.status, 'approved')
    const { rows: [device] } = await db.query('SELECT hostname, platform, managed_by, profile FROM devices WHERE id = $1', [stored.device_id])
    assert.deepEqual(device, { hostname: 'lx-' + key.serial_claimed.toLowerCase(), platform: 'linux', managed_by: 'pull', profile: 'field' })
  }
  assert.equal((await keyStatus(conflict.id)).status, 'pending')
  assert.equal((await api('POST', '/api/linux/enrollments/approve-bulk', { payload: { ids: [], profile: 'field', ring: 'pilot' } })).statusCode, 400)
})

test('POST /enrollments/reject-bulk — comptes et erreurs par ligne', { skip: SKIP }, async () => {
  const a = await pendingKey('SN-RBULK-A')
  const b = await pendingKey('SN-RBULK-B')
  await api('POST', `/api/linux/enrollments/${b.id}/reject`, { payload: {} })
  const res = await api('POST', '/api/linux/enrollments/reject-bulk', { payload: { ids: [a.id, b.id], reason: 'lot' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: 1, skipped: 1, errors: [{ id: b.id, code: 'NOT_PENDING' }] })
  assert.equal((await keyStatus(a.id)).status, 'rejected')
})

test('pré-inscriptions — import (BulkResult), liste (Preregistration), from-devices, suppression 204 puis 404', { skip: SKIP }, async () => {
  // Nom d'un poste Windows (majuscules) demandé en minuscules pour une autre série : pris.
  await seedDevice(db, { hostname: 'PC-PRE-TAKEN' })
  const imported = await api('POST', '/api/linux/preregistrations', { payload: { rows: [
    { serial: 'pf3abc12', hostname: 'lx-dupont', profile: 'field', ring: 'stable', email: 'j.dupont@example.org', note: 'ok' },
    { serial: 'To be filled by O.E.M.', profile: 'field', ring: 'stable' },
    { serial: 'SN-PRE-TAKEN', hostname: 'PC-PRE-TAKEN'.toLowerCase(), profile: 'field', ring: 'stable' },
  ] } })
  assert.equal(imported.statusCode, 200, imported.body)
  assert.deepEqual(imported.json(), { ok: 1, skipped: 2, errors: [{ id: '1', code: 'PLACEHOLDER_SERIAL' }, { id: '2', code: 'HOSTNAME_TAKEN' }] })
  // Validation de schéma avant le handler : ring inconnu, ligne vide.
  assert.equal((await api('POST', '/api/linux/preregistrations', { payload: { rows: [{ serial: 'SN-X', profile: 'field', ring: 'canary' }] } })).statusCode, 400)
  assert.equal((await api('POST', '/api/linux/preregistrations', { payload: { rows: [] } })).statusCode, 400)
  const { rows: [audit] } = await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'linux_preregistrations_imported' ORDER BY created_at DESC LIMIT 1")
  assert.equal(audit.by_user, 'Admin Lx')

  const list = await api('GET', '/api/linux/preregistrations')
  assert.equal(list.statusCode, 200, list.body)
  const dupont = list.json().rows.find(r => r.serial === 'PF3ABC12')
  assert.equal(dupont.hostname, 'lx-dupont')
  assert.deepEqual(dupont.assigned_user, { entra_id: 'oid-lxa-user', display_name: 'Jean Dupont', email: 'J.Dupont@Example.org' })
  assert.equal(dupont.matches_device, null)
  assert.equal(dupont.consumed_at, null)
  assert.equal(dupont.created_by, 'Admin Lx')

  // Préparation de la migration depuis Postes : série, nom, utilisateur repris.
  const win = await seedDevice(db, { hostname: 'PC-MIGRATE-ROUTE', serial: 'SN-MIGRATE-ROUTE' })
  const pull = await seedDevice(db, { hostname: 'lx-already-route', serial: 'SN-PULL-ROUTE', platform: 'linux', managed_by: 'pull' })
  const prepared = await api('POST', '/api/linux/preregistrations/from-devices', { payload: { device_ids: [win.id, pull.id], profile: 'admin', ring: 'pilot' } })
  assert.equal(prepared.statusCode, 200, prepared.body)
  assert.deepEqual(prepared.json(), { ok: 1, skipped: 1, errors: [{ id: pull.id, code: 'PULL_MANAGED' }] })
  assert.equal((await api('POST', '/api/linux/preregistrations/from-devices', { payload: { profile: 'admin', ring: 'pilot' } })).statusCode, 400, 'device_ids ou group_id requis')
  const migrate = (await api('GET', '/api/linux/preregistrations')).json().rows.find(r => r.serial === 'SN-MIGRATE-ROUTE')
  assert.equal(migrate.hostname, 'PC-MIGRATE-ROUTE')
  assert.deepEqual(migrate.matches_device, { id: win.id, hostname: 'PC-MIGRATE-ROUTE', platform: null, managed_by: null })

  // Suppression : 204 une fois, 404 ensuite ; une réservation consommée reste.
  assert.equal((await api('DELETE', `/api/linux/preregistrations/${migrate.id}`)).statusCode, 204)
  assert.equal((await api('DELETE', `/api/linux/preregistrations/${migrate.id}`)).statusCode, 404)
  await db.query('UPDATE linux_preregistrations SET consumed_at = now() WHERE id = $1', [dupont.id])
  assert.equal((await api('DELETE', `/api/linux/preregistrations/${dupont.id}`)).statusCode, 404)
  const consumed = await api('GET', '/api/linux/preregistrations?consumed=true')
  assert.deepEqual(consumed.json().rows.map(r => r.id), [dupont.id])
})

test('POST /devices/:id/revoke — clé révoquée avec motif (LinuxDeviceDetail), puis NO_ACTIVE_KEY ; poste non pull 404 ; motif trop court 400', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-revoke-route', serial: 'SN-REV-ROUTE', platform: 'linux', managed_by: 'pull' })
  const key = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-REV-ROUTE' })
  assert.equal((await api('POST', `/api/linux/devices/${pull.id}/revoke`, { payload: { reason: 'x' } })).statusCode, 400)
  const res = await api('POST', `/api/linux/devices/${pull.id}/revoke`, { payload: { reason: 'Poste volé' } })
  assert.equal(res.statusCode, 200, res.body)
  const detail = res.json()
  assert.equal(detail.id, pull.id)
  assert.equal(detail.key.id, key.id)
  assert.equal(detail.key.status, 'revoked')
  assert.equal(detail.key.revoke_reason, 'Poste volé')
  assert.equal(detail.key.revoked_by, 'Admin Lx')
  assert.ok(detail.key.revoked_at)
  assert.equal((await db.query('SELECT 1 FROM devices WHERE id = $1', [pull.id])).rowCount, 1, 'ligne devices conservée')
  const { rows: [audit] } = await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'linux_device_revoked' AND target = $1", [pull.id])
  assert.equal(audit.by_user, 'Admin Lx')
  assert.equal(audit.details.reason, 'Poste volé')
  const again = await api('POST', `/api/linux/devices/${pull.id}/revoke`, { payload: { reason: 'Encore une fois' } })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'NO_ACTIVE_KEY')
  const win = await seedDevice(db, { hostname: 'PC-NOT-PULL-ROUTE' })
  assert.equal((await api('POST', `/api/linux/devices/${win.id}/revoke`, { payload: { reason: 'Poste volé' } })).statusCode, 404)
})
