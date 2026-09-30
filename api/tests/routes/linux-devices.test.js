// Routes admin des postes Linux (préfixe /api/linux) : liste paginée et
// filtrée (LinuxDevice, retard mesuré contre les têtes du miroir), détail
// (LinuxDeviceDetail), affectation simple et en lot avec audit, état de la
// clé d'escrow. Miroir simulé, clé LAPS temporaire, base réelle.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { insertAdminCredential } from '../fixtures/admin-credentials.js'
import { loadSpec, deref } from '../../modules/linux/lib/spec.js'
import { lapsKeyId } from '../../modules/inventory/lib/laps-key.js'
import devicesRoutes from '../../modules/linux/routes/devices.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const NIL = '00000000-0000-4000-8000-000000000000'
const SHA = c => c.repeat(40)
const PILOT_TIP = SHA('a'), STABLE_TIP = SHA('b'), OLD = SHA('0')

let db, release, app, jwt, admin, user, tmpDir, validateDevice, validateDetail, validateReport
const prevKeyPath = process.env.LAPS_PRIVATE_KEY
// Miroir simulé : pilot installé depuis une heure (retard mesurable), stable promu à l'instant.
const mirror = { serving: true }
const gitMirror = {
  serving: () => mirror.serving,
  status: () => ({ state: mirror.serving ? 'ready' : 'absent' }),
  heads: () => ({ pilot: PILOT_TIP, stable: STABLE_TIP, upstream: { main: PILOT_TIP } }),
  tipSince: ring => ring === 'pilot' ? new Date(Date.now() - 3_600_000).toISOString() : new Date().toISOString(),
  listProfiles: async ref => ref === 'refs/heads/pilot' ? ['admin', 'field'] : ['admin'],
}
const devices = {}

before(async () => {
  if (SKIP) return
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-devices-'))
  process.env.LAPS_PRIVATE_KEY = path.join(tmpDir, 'laps.key')
  await fs.writeFile(process.env.LAPS_PRIVATE_KEY, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  app = await buildApp({ db, jwks: jwt.jwks, decorators: { gitMirror }, routes: f => f.register(devicesRoutes, { prefix: '/api/linux' }) })
  const a = await seedAdmin(db, { entraId: 'oid-lxd-admin', displayName: 'Admin Lxd', email: 'admin-lxd@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  const u = await seedNonAdmin(db, { entraId: 'oid-lxd-user', displayName: 'Marie Curie', email: 'm.curie@example.org' })
  user = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }

  // p1 : pilot à jour, en ligne, LUKS sans clé escrowée, utilisateur affecté.
  devices.p1 = await seedDevice(db, { hostname: 'lx-p1', serial: 'SN-P1', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'pilot' })
  await db.query("UPDATE devices SET assigned_user_id = 'oid-lxd-user', last_successful_revision = $2, last_apply_status = 'success' WHERE id = $1", [devices.p1.id, PILOT_TIP])
  devices.k1 = await seedLinuxDeviceKey(db, { deviceId: devices.p1.id, status: 'approved', serialClaimed: 'SN-P1' })
  await db.query('UPDATE linux_device_keys SET luks_root = true WHERE id = $1', [devices.k1.id])
  // p2 : pilot en retard, hors ligne, clé révoquée, profil absent du dépôt, apply en échec.
  devices.p2 = await seedDevice(db, { hostname: 'lx-p2', serial: 'SN-P2', platform: 'linux', managed_by: 'pull', profile: 'ghost', ring: 'pilot', lastSeenMinutesAgo: 120 })
  await db.query("UPDATE devices SET last_successful_revision = $2, last_apply_status = 'failed' WHERE id = $1", [devices.p2.id, OLD])
  await seedLinuxDeviceKey(db, { deviceId: devices.p2.id, status: 'revoked', serialClaimed: 'SN-P2' })
  // s1 : stable derrière une tête trop récente pour compter, LUKS escrowé sous la clé courante.
  devices.s1 = await seedDevice(db, { hostname: 'lx-s1', serial: 'SN-S1', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'stable' })
  await db.query('UPDATE devices SET last_successful_revision = $2 WHERE id = $1', [devices.s1.id, OLD])
  devices.k3 = await seedLinuxDeviceKey(db, { deviceId: devices.s1.id, status: 'approved', serialClaimed: 'SN-S1' })
  await db.query('UPDATE linux_device_keys SET luks_root = true WHERE id = $1', [devices.k3.id])
  await db.query("INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id) VALUES ($1, 'luks_recovery', '/', '\\x00', $2)", [devices.s1.id, lapsKeyId()])
  devices.win = await seedDevice(db, { hostname: 'PC-WIN', serial: 'SN-WIN' })

  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validateDevice = ajv.compile(deref(loadSpec().components.schemas.LinuxDevice))
  validateDetail = ajv.compile(deref(loadSpec().components.schemas.LinuxDeviceDetail))
  validateReport = ajv.compile(deref(loadSpec().components.schemas.ApplyReport))
})

after(async () => {
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  if (prevKeyPath === undefined) delete process.env.LAPS_PRIVATE_KEY; else process.env.LAPS_PRIVATE_KEY = prevKeyPath
})

const api = (method, url, { headers = admin, payload } = {}) => app.inject({ method, url, headers, payload })
const hostnames = res => res.json().rows.map(r => r.hostname)
const list = async query => {
  const res = await api('GET', '/api/linux/devices' + (query ? `?${query}` : ''))
  assert.equal(res.statusCode, 200, res.body)
  return res
}

test('routes postes : sans Bearer → 401, non-admin → 403', { skip: SKIP }, async () => {
  for (const [method, url, payload] of [
    ['GET', '/api/linux/devices'], ['GET', `/api/linux/devices/${NIL}`], ['PATCH', `/api/linux/devices/${NIL}`, { ring: 'pilot' }],
    ['POST', '/api/linux/devices/assign-bulk', { ids: [NIL], ring: 'pilot' }], ['GET', '/api/linux/escrow/status'],
  ]) {
    assert.equal((await api(method, url, { headers: {}, payload })).statusCode, 401, `${method} ${url}`)
    assert.equal((await api(method, url, { headers: user, payload })).statusCode, 403, `${method} ${url}`)
  }
})

test('GET /devices — lignes LinuxDevice (postes pull seulement), retard et profil mesurés contre le miroir, pagination', { skip: SKIP }, async () => {
  const res = await list()
  assert.deepEqual(hostnames(res), ['lx-p1', 'lx-p2', 'lx-s1'])
  assert.equal(res.json().total, 3)
  for (const row of res.json().rows) assert.ok(validateDevice(row), `${row.hostname} : ${JSON.stringify(validateDevice.errors)}`)
  const [p1, p2, s1] = res.json().rows
  assert.deepEqual([p1.ring_tip, p1.lagging, p1.profile_in_repo, p1.online, p1.needs_escrow], [PILOT_TIP, false, true, true, true])
  assert.deepEqual([p2.ring_tip, p2.lagging, p2.profile_in_repo, p2.online, p2.needs_escrow], [PILOT_TIP, true, false, false, false])
  assert.deepEqual([s1.ring_tip, s1.lagging, s1.profile_in_repo, s1.needs_escrow], [STABLE_TIP, false, true, false], 'tête stable trop récente : pas encore en retard')
  assert.deepEqual(p1.assigned_user, { entra_id: 'oid-lxd-user', display_name: 'Marie Curie', email: 'm.curie@example.org' })
  assert.equal(p1.key.id, devices.k1.id)
  assert.equal(p1.key.status, 'approved')
  assert.equal(p1.key.luks_root, undefined, 'luks_root n’est pas dans KeyInfo')
  assert.equal(p2.key.status, 'revoked')
  assert.equal(p1.platform, 'linux')
  assert.equal(p1.managed_by, 'pull')

  const page = await list('limit=2&offset=1')
  assert.deepEqual(hostnames(page), ['lx-p2', 'lx-s1'])
  assert.equal(page.json().total, 3)
  assert.equal((await api('GET', '/api/linux/devices?limit=0')).statusCode, 400)
  assert.equal((await api('GET', '/api/linux/devices?ring=canary')).statusCode, 400)
})

test('GET /devices — chaque filtre : status, profile, ring, lagging, apply_status, escrow, online, q', { skip: SKIP }, async () => {
  const cases = [
    ['status=approved', ['lx-p1', 'lx-s1']], ['status=revoked', ['lx-p2']],
    ['profile=ghost', ['lx-p2']], ['ring=stable', ['lx-s1']],
    ['lagging=true', ['lx-p2']], ['lagging=false', ['lx-p1', 'lx-s1']],
    ['apply_status=failed', ['lx-p2']],
    ['escrow=missing', ['lx-p1']], ['escrow=ok', ['lx-p2', 'lx-s1']],
    ['online=true', ['lx-p1', 'lx-s1']], ['online=false', ['lx-p2']],
    ['q=P2', ['lx-p2']], ['q=sn-s1', ['lx-s1']], ['q=curie', ['lx-p1']],
    ['ring=pilot&online=true', ['lx-p1']],
  ]
  for (const [query, expected] of cases) assert.deepEqual(hostnames(await list(query)), expected, query)
})

test('GET /devices — miroir non servi : ring_tip, lagging et profile_in_repo null ; filtre lagging vide', { skip: SKIP }, async () => {
  mirror.serving = false
  try {
    const res = await list()
    for (const row of res.json().rows) {
      assert.deepEqual([row.ring_tip, row.lagging, row.profile_in_repo], [null, null, null], row.hostname)
      assert.ok(validateDevice(row))
    }
    assert.deepEqual(hostnames(await list('lagging=true')), [])
    assert.deepEqual(hostnames(await list('lagging=false')), [])
  } finally {
    mirror.serving = true
  }
})

test('GET /devices/:id — LinuxDeviceDetail avec dernier rapport, clés de récupération et LAPS ; poste Windows ou inconnu → 404', { skip: SKIP }, async () => {
  await db.query(`
    INSERT INTO linux_apply_reports (device_id, revision, status, started_at, finished_at, error_summary, log_tail, agent_version)
    VALUES ($1, $2, 'success', now() - interval '2 hours', now() - interval '2 hours', NULL, NULL, '0.1.0'),
           ($1, $2, 'failed',  now() - interval '1 hour',  now() - interval '59 minutes', 'TASK [x] failed', 'PLAY…', '0.2.0')
  `, [devices.s1.id, OLD])
  await db.query("INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id, created_at, superseded_at) VALUES ($1, 'luks_recovery', '/', '\\x00', 'old-key', now() - interval '1 day', now())", [devices.s1.id])
  await insertAdminCredential(db, { device_id: devices.s1.id, username: 'opale-recovery' })
  const res = await api('GET', `/api/linux/devices/${devices.s1.id}`)
  assert.equal(res.statusCode, 200, res.body)
  const d = res.json()
  assert.ok(validateDetail(d), JSON.stringify(validateDetail.errors))
  assert.equal(d.id, devices.s1.id)
  assert.equal(d.luks_root, true)
  assert.equal(d.kernel, null)
  assert.equal(d.converted_from_windows, false)
  assert.equal(d.last_report.status, 'failed', 'rapport le plus récent')
  assert.equal(d.last_report.error_summary, 'TASK [x] failed')
  assert.equal(d.last_report.revision, OLD)
  assert.deepEqual(d.recovery_keys.map(k => [k.key_id, k.current, k.superseded_at === null]), [[lapsKeyId(), true, true], ['old-key', false, false]])
  assert.equal(d.laps.username, 'opale-recovery')
  assert.equal(d.laps.rotation_requested_at, null)
  assert.equal(d.key.id, devices.k3.id)
  assert.equal((await api('GET', `/api/linux/devices/${devices.win.id}`)).statusCode, 404)
  assert.equal((await api('GET', `/api/linux/devices/${NIL}`)).statusCode, 404)
  assert.equal((await api('GET', '/api/linux/devices/pas-un-uuid')).statusCode, 400)
})

test('PATCH /devices/:id — profil/ring audités avant/après, utilisateur via le helper partagé (device_assigned), 400 / 404', { skip: SKIP }, async () => {
  const res = await api('PATCH', `/api/linux/devices/${devices.p2.id}`, { payload: { profile: 'field', ring: 'stable', assigned_user_id: 'oid-lxd-user' } })
  assert.equal(res.statusCode, 200, res.body)
  const d = res.json()
  assert.ok(validateDetail(d), JSON.stringify(validateDetail.errors))
  assert.deepEqual([d.profile, d.ring, d.ring_tip, d.profile_in_repo], ['field', 'stable', STABLE_TIP, false])
  assert.equal(d.assigned_user.entra_id, 'oid-lxd-user')
  const { rows: [assignment] } = await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'linux_assignment_changed' AND target = $1", [devices.p2.id])
  assert.equal(assignment.by_user, 'Admin Lxd')
  assert.deepEqual(assignment.details, { hostname: 'lx-p2', before: { profile: 'ghost', ring: 'pilot' }, after: { profile: 'field', ring: 'stable' } })
  const { rows: [assigned] } = await db.query("SELECT details FROM audit_logs WHERE action = 'device_assigned' AND target = $1", [devices.p2.id])
  assert.deepEqual(assigned.details, { before: null, after: 'oid-lxd-user' })

  const unassign = await api('PATCH', `/api/linux/devices/${devices.p2.id}`, { payload: { assigned_user_id: null } })
  assert.equal(unassign.statusCode, 200, unassign.body)
  assert.equal(unassign.json().assigned_user, null)
  const unknown = await api('PATCH', `/api/linux/devices/${devices.p2.id}`, { payload: { assigned_user_id: 'oid-inconnu' } })
  assert.equal(unknown.statusCode, 400)
  assert.equal(unknown.json().code, 'UNKNOWN_USER')
  assert.equal((await api('PATCH', `/api/linux/devices/${devices.p2.id}`, { payload: {} })).statusCode, 400, 'minProperties')
  assert.equal((await api('PATCH', `/api/linux/devices/${devices.p2.id}`, { payload: { profile: 'Majuscule' } })).statusCode, 400, 'ProfileSlug')
  assert.equal((await api('PATCH', `/api/linux/devices/${devices.win.id}`, { payload: { ring: 'pilot' } })).statusCode, 404)
  assert.equal((await api('PATCH', `/api/linux/devices/${NIL}`, { payload: { ring: 'pilot' } })).statusCode, 404)
})

test('POST /devices/assign-bulk — par groupe natif avec lignes non pull ignorées, par ids, rien à affecter → 400', { skip: SKIP }, async () => {
  const { rows: [group] } = await db.query("INSERT INTO groups (name) VALUES ('Lot Linux') RETURNING id")
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2), ($1, $3), ($1, $4)', [group.id, devices.p1.id, devices.s1.id, devices.win.id])
  const res = await api('POST', '/api/linux/devices/assign-bulk', { payload: { group_id: group.id, ring: 'stable' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: 2, skipped: 1, errors: [{ id: devices.win.id, code: 'NOT_PULL_MANAGED' }] })
  const { rows } = await db.query('SELECT hostname, ring FROM devices WHERE id = ANY($1::uuid[]) ORDER BY hostname COLLATE "C"', [[devices.p1.id, devices.s1.id, devices.win.id]])
  assert.deepEqual(rows, [{ hostname: 'PC-WIN', ring: null }, { hostname: 'lx-p1', ring: 'stable' }, { hostname: 'lx-s1', ring: 'stable' }])
  const { rows: audits } = await db.query("SELECT target FROM audit_logs WHERE action = 'linux_assignment_changed' AND details->'after'->>'ring' = 'stable' AND target = $1", [devices.p1.id])
  assert.equal(audits.length, 1, 'audit par poste')
  const byIds = await api('POST', '/api/linux/devices/assign-bulk', { payload: { ids: [devices.p1.id, NIL], profile: 'field' } })
  assert.deepEqual(byIds.json(), { ok: 1, skipped: 1, errors: [{ id: NIL, code: 'NOT_FOUND' }] })
  const nothing = await api('POST', '/api/linux/devices/assign-bulk', { payload: { ids: [devices.p1.id] } })
  assert.equal(nothing.statusCode, 400)
  assert.equal(nothing.json().code, 'NOTHING_TO_ASSIGN')
  assert.equal((await api('POST', '/api/linux/devices/assign-bulk', { payload: { ring: 'pilot' } })).statusCode, 400, 'ids ou group_id requis')
})

test('GET /escrow/status — clé dérivée (key_id, bits), confirmation de sauvegarde lue du réglage, postes à escrower', { skip: SKIP }, async () => {
  const res = await api('GET', '/api/linux/escrow/status')
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { status: 'ok', key_id: lapsKeyId(), bits: 2048, backup_confirmed: null, devices_needing_escrow: 1 })
  const confirmed = { key_id: lapsKeyId(), by: 'Admin Lxd', at: '2026-09-30T10:00:00.000Z' }
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.escrow_backup_confirmed'", [JSON.stringify(confirmed)])
  assert.deepEqual((await api('GET', '/api/linux/escrow/status')).json().backup_confirmed, confirmed)
})

test('GET /devices/:id/reports — lignes ApplyReport du plus récent au plus ancien, filtre status, pagination, poste Windows ou inconnu → 404', { skip: SKIP }, async () => {
  await db.query("INSERT INTO linux_apply_reports (device_id, revision, status, started_at, finished_at) VALUES ($1, $2, 'skipped', now() - interval '30 minutes', now() - interval '30 minutes')", [devices.s1.id, OLD])
  const res = await api('GET', `/api/linux/devices/${devices.s1.id}/reports`)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().total, 3)
  assert.deepEqual(res.json().rows.map(r => r.status), ['skipped', 'failed', 'success'])
  for (const row of res.json().rows) assert.ok(validateReport(row), JSON.stringify(validateReport.errors))
  assert.equal(res.json().rows[1].log_tail, 'PLAY…')
  const failed = await api('GET', `/api/linux/devices/${devices.s1.id}/reports?status=failed`)
  assert.deepEqual([failed.json().total, failed.json().rows[0].error_summary], [1, 'TASK [x] failed'])
  const page = await api('GET', `/api/linux/devices/${devices.s1.id}/reports?limit=1&offset=1`)
  assert.deepEqual([page.json().total, page.json().rows.map(r => r.status)], [3, ['failed']])
  assert.deepEqual((await api('GET', `/api/linux/devices/${devices.p1.id}/reports`)).json(), { rows: [], total: 0 })
  assert.equal((await api('GET', `/api/linux/devices/${devices.s1.id}/reports?status=bogus`)).statusCode, 400)
  assert.equal((await api('GET', `/api/linux/devices/${devices.s1.id}/reports?limit=0`)).statusCode, 400)
  assert.equal((await api('GET', `/api/linux/devices/${devices.win.id}/reports`)).statusCode, 404)
  assert.equal((await api('GET', `/api/linux/devices/${NIL}/reports`)).statusCode, 404)
  assert.equal((await api('GET', `/api/linux/devices/${devices.s1.id}/reports`, { headers: user })).statusCode, 403)
})
