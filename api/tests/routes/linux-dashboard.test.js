// GET /api/linux/dashboard (LinuxDashboard, docs/linux-fleet-design.md §5) :
// KPIs sur un parc semé (à jour, en retard, en échec, hors ligne, non
// escrowé, demandes en attente, poste Windows exclu), seuil agent_offline_days,
// miroir non servi. Miroir simulé, clé LAPS temporaire, base réelle.

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
import { loadSpec, deref } from '../../modules/linux/lib/spec.js'
import { lapsKeyId } from '../../modules/inventory/lib/laps-key.js'
import devicesRoutes from '../../modules/linux/routes/devices.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)
const PILOT_TIP = SHA('a'), STABLE_TIP = SHA('b'), OLD = SHA('0')

let db, release, app, jwt, admin, user, tmpDir, validate
const prevKeyPath = process.env.LAPS_PRIVATE_KEY
// Pilot installé depuis une heure (retard mesurable), stable promu à l'instant.
const mirror = { serving: true }
const gitMirror = {
  serving: () => mirror.serving,
  status: () => ({ state: mirror.serving ? 'ready' : 'absent' }),
  heads: () => ({ pilot: PILOT_TIP, stable: STABLE_TIP, upstream: { main: PILOT_TIP } }),
  tipSince: ring => ring === 'pilot' ? new Date(Date.now() - 3_600_000).toISOString() : new Date().toISOString(),
  listProfiles: async () => ['field'],
}

async function pull(hostname, { revision, status, ...device }) {
  const row = await seedDevice(db, { hostname, serial: hostname.toUpperCase(), platform: 'linux', managed_by: 'pull', profile: 'field', ...device })
  await db.query('UPDATE devices SET last_successful_revision = $2, last_apply_status = $3 WHERE id = $1', [row.id, revision, status])
  return row
}

before(async () => {
  if (SKIP) return
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-dashboard-'))
  process.env.LAPS_PRIVATE_KEY = path.join(tmpDir, 'laps.key')
  await fs.writeFile(process.env.LAPS_PRIVATE_KEY, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  app = await buildApp({ db, jwks: jwt.jwks, decorators: { gitMirror }, routes: f => f.register(devicesRoutes, { prefix: '/api/linux' }) })
  const a = await seedAdmin(db, { entraId: 'oid-lxdash-admin', displayName: 'Admin Dash', email: 'admin-dash@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  const u = await seedNonAdmin(db, { entraId: 'oid-lxdash-user' })
  user = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }

  // À jour sur pilot, LUKS escrowé sous la clé courante.
  const tip = await pull('lx-tip', { ring: 'pilot', revision: PILOT_TIP, status: 'success' })
  const tipKey = await seedLinuxDeviceKey(db, { deviceId: tip.id, status: 'approved', serialClaimed: 'LX-TIP' })
  await db.query('UPDATE linux_device_keys SET luks_root = true WHERE id = $1', [tipKey.id])
  await db.query("INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id) VALUES ($1, 'luks_recovery', '/', '\\x00', $2)", [tip.id, lapsKeyId()])
  // En retard sur pilot (tête installée depuis une heure).
  await pull('lx-lag', { ring: 'pilot', revision: OLD, status: 'success' })
  // Stable derrière une tête trop récente pour compter, dernier apply partiel.
  await pull('lx-fail', { ring: 'stable', revision: OLD, status: 'partial' })
  // Jamais appliqué, hors ligne depuis dix jours.
  await pull('lx-off', { ring: 'stable', revision: null, status: null, lastSeenMinutesAgo: 10 * 24 * 60 })
  // LUKS sans clé de récupération escrowée.
  const luks = await pull('lx-luks', { ring: 'pilot', revision: PILOT_TIP, status: 'success' })
  const luksKey = await seedLinuxDeviceKey(db, { deviceId: luks.id, status: 'approved', serialClaimed: 'LX-LUKS' })
  await db.query('UPDATE linux_device_keys SET luks_root = true WHERE id = $1', [luksKey.id])
  // Deux demandes en attente, un poste Windows hors périmètre.
  await seedLinuxDeviceKey(db, { status: 'pending', serialClaimed: 'SN-DASH-P1' })
  await seedLinuxDeviceKey(db, { status: 'pending', serialClaimed: 'SN-DASH-P2' })
  await seedDevice(db, { hostname: 'PC-WIN', serial: 'SN-WIN', lastSeenMinutesAgo: 30 * 24 * 60 })

  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validate = ajv.compile(deref(loadSpec().components.schemas.LinuxDashboard))
})

after(async () => {
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  if (prevKeyPath === undefined) delete process.env.LAPS_PRIVATE_KEY; else process.env.LAPS_PRIVATE_KEY = prevKeyPath
})

async function dashboard(headers = admin) {
  const res = await app.inject({ method: 'GET', url: '/api/linux/dashboard', headers })
  return res
}

test('GET /dashboard — sans Bearer → 401, non-admin → 403', { skip: SKIP }, async () => {
  assert.equal((await dashboard({})).statusCode, 401)
  assert.equal((await dashboard(user)).statusCode, 403)
})

test('GET /dashboard — LinuxDashboard : postes pull seulement, révisions groupées (nulle comprise), retard, hors ligne, échecs, attente, escrow, miroir', { skip: SKIP }, async () => {
  const res = await dashboard()
  assert.equal(res.statusCode, 200, res.body)
  const d = res.json()
  assert.ok(validate(d), JSON.stringify(validate.errors))
  assert.deepEqual(d, {
    devices_total: 5,
    by_revision: [
      { revision: PILOT_TIP, ring: 'pilot', count: 2 },
      { revision: OLD, ring: 'pilot', count: 1 },
      { revision: OLD, ring: 'stable', count: 1 },
      { revision: null, ring: 'stable', count: 1 },
    ],
    lagging: 1,
    offline: { days: 7, count: 1 },
    failed_applies: 1,
    pending_approvals: 2,
    not_escrowed: 1,
    mirror_state: 'ready',
  })
})

test('GET /dashboard — seuil agent_offline_days lu des réglages ; miroir non servi : retard inconnu (0) et état du miroir', { skip: SKIP }, async () => {
  await db.query("INSERT INTO settings (key, value) VALUES ('agent_offline_days', '20') ON CONFLICT (key) DO UPDATE SET value = '20'")
  try {
    assert.deepEqual((await dashboard()).json().offline, { days: 20, count: 0 })
  } finally {
    await db.query("DELETE FROM settings WHERE key = 'agent_offline_days'")
  }
  mirror.serving = false
  try {
    const d = (await dashboard()).json()
    assert.ok(validate(d), JSON.stringify(validate.errors))
    assert.deepEqual([d.lagging, d.mirror_state, d.devices_total, d.failed_applies, d.not_escrowed], [0, 'absent', 5, 1, 1])
  } finally {
    mirror.serving = true
  }
})
