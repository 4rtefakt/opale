// lib/convert.js : effacement des faits Windows lors d'une conversion et
// création d'une ligne devices gérée par état désiré.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage } from '../fixtures/packages.js'
import { clearWindowsFacts, createPullDevice } from '../../modules/linux/lib/convert.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

const CLEARED_COLUMNS = ['health_signals', 'health_updated_at', 'system_info', 'ssh_host_key_fp', 'ssh_host_key_learned_at',
  'ip_netbird', 'agent_version', 'intune_device_id', 'aad_device_id', 'intune_user_id', 'intune_user_display_name',
  'intune_last_sync', 'compliance_state', 'enrolled_at', 'last_seen_ws']

test('clearWindowsFacts — sous-tables vidées, colonnes Windows à NULL, tokens actifs révoqués, identité et voisin intacts', { skip: SKIP }, async () => {
  const win = await seedDevice(db, { hostname: 'PC-FACTS', serial: 'SN-FACTS', ipNetbird: '100.64.0.5' })
  const neighbour = await seedDevice(db, { hostname: 'PC-NEIGHBOUR', ipNetbird: '100.64.0.6' })
  await db.query(`UPDATE devices SET health_signals = '{"x":1}', health_updated_at = now(), system_info = '{"a":1}',
    ssh_host_key_fp = 'SHA256:x', ssh_host_key_learned_at = now(), agent_version = '2.15.3',
    intune_device_id = 'intune-' || hostname, aad_device_id = 'aad-' || hostname, intune_user_id = 'u1',
    intune_user_display_name = 'U', intune_last_sync = now(), compliance_state = 'compliant', enrolled_at = now(),
    last_seen_ws = now(), os = 'Windows 11', model = 'ThinkPad'
    WHERE id = ANY($1::uuid[])`, [[win.id, neighbour.id]])
  const pkg = await insertPackage(db, { name: 'Pkg facts' })
  for (const id of [win.id, neighbour.id]) {
    await db.query("INSERT INTO disks (device_id, letter) VALUES ($1, 'C:'), ($1, 'D:')", [id])
    await db.query("INSERT INTO network_interfaces (device_id, adapter) VALUES ($1, 'eth0')", [id])
    await db.query('INSERT INTO device_software (device_id, package_id) VALUES ($1, $2)', [id, pkg.id])
    await db.query("INSERT INTO compliance_results (device_id, rule_id, status, severity) VALUES ($1, 'r1', 'pass', 'high'), ($1, 'r2', 'fail', 'low')", [id])
  }
  const active = await seedAgentToken(db, { deviceId: win.id, label: 'active' })
  const already = await seedAgentToken(db, { deviceId: win.id, label: 'already', revokedAt: new Date(Date.now() - 60_000).toISOString() })
  const other = await seedAgentToken(db, { deviceId: neighbour.id, label: 'other' })

  const counts = await clearWindowsFacts(db, win.id)
  assert.deepEqual(counts, { compliance_results: 2, disks: 2, network_interfaces: 1, device_software: 1, agent_tokens: 1 })

  const { rows: [row] } = await db.query('SELECT * FROM devices WHERE id = $1', [win.id])
  for (const column of CLEARED_COLUMNS) assert.equal(row[column], null, `${column} effacé`)
  assert.equal(row.hostname, 'PC-FACTS')
  assert.equal(row.serial, 'SN-FACTS')
  assert.equal(row.os, 'Windows 11', 'os conservé (le check-in Linux le réécrit)')
  assert.equal(row.model, 'ThinkPad')
  const { rows: tokens } = await db.query('SELECT id, revoked_at FROM agent_tokens WHERE id = ANY($1::uuid[]) ORDER BY label', [[active.id, already.id, other.id]])
  assert.ok(tokens.find(t => t.id === active.id).revoked_at, 'token actif révoqué')
  assert.equal(tokens.find(t => t.id === other.id).revoked_at, null, 'token du voisin intact')
  assert.ok(new Date(tokens.find(t => t.id === already.id).revoked_at) < new Date(Date.now() - 30_000), 'révocation antérieure conservée')

  const { rows: [n] } = await db.query('SELECT agent_version, (SELECT count(*)::int FROM disks WHERE device_id = $1) AS disks FROM devices WHERE id = $1', [neighbour.id])
  assert.deepEqual(n, { agent_version: '2.15.3', disks: 2 }, 'voisin intact')
  assert.deepEqual(await clearWindowsFacts(db, win.id), { compliance_results: 0, disks: 0, network_interfaces: 0, device_software: 0, agent_tokens: 0 }, 'idempotent')
})

test('createPullDevice — ligne marquée côté serveur, utilisateur optionnel', { skip: SKIP }, async () => {
  const device = await createPullDevice(db, { hostname: 'lx-new', serial: 'SN-NEW', profile: 'field', ring: 'pilot' })
  assert.equal(device.platform, 'linux')
  assert.equal(device.managed_by, 'pull')
  assert.equal(device.source, 'agent')
  assert.equal(device.profile, 'field')
  assert.equal(device.ring, 'pilot')
  assert.equal(device.assigned_user_id, null)
  assert.equal(device.ip_netbird, null)
  assert.equal(device.agent_version, null)
  await assert.rejects(createPullDevice(db, { hostname: 'lx-new', serial: 'SN-NEW-2', profile: 'field', ring: 'pilot' }), err => err.code === '23505')
})
