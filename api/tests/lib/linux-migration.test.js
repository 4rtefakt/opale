import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
after(closeSharedPool)

async function database(t) {
  const acquired = await acquireSchema()
  t.after(acquired.release)
  return acquired.db
}

test('fixture Linux : empreinte SHA-256 des 32 octets bruts, paire Ed25519 utilisable et options persistées', { skip: SKIP }, async (t) => {
  const db = await database(t)
  const device = await seedDevice(db, {
    serial: 'LINUX-TEST', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'pilot',
  })
  const key = await seedLinuxDeviceKey(db, {
    deviceId: device.id, status: 'approved', serialClaimed: 'LINUX-TEST', hostnameClaimed: 'debian', keyBacking: 'tpm',
  })
  assert.equal(key.publicKeyRaw.length, 32)
  assert.equal(key.fingerprint, createHash('sha256').update(key.publicKeyRaw).digest('hex'))
  const public_key = createPublicKey(key.privateKey)
  assert.deepEqual(public_key.export({ type: 'spki', format: 'der' }).subarray(-32), key.publicKeyRaw)
  const message = Buffer.from('test de signature')
  assert.ok(verify(null, message, public_key, sign(null, message, key.privateKey)))
  const { rows: [row] } = await db.query('SELECT * FROM linux_device_keys WHERE id = $1', [key.id])
  assert.deepEqual([row.device_id, row.status, row.serial_claimed, row.hostname_claimed, row.key_backing],
    [device.id, 'approved', 'LINUX-TEST', 'debian', 'tpm'])
  assert.deepEqual(row.public_key, key.publicKeyRaw)
  assert.equal(row.key_fingerprint, key.fingerprint)
  assert.equal(row.source, 'manual')
  assert.equal(row.enroll_attempts, 1)
  assert.ok(row.first_seen_at && row.last_seen_at)
  const fields = await db.query('SELECT serial, platform, managed_by, profile, ring FROM devices WHERE id = $1', [device.id])
  assert.deepEqual(fields.rows[0], { serial: 'LINUX-TEST', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'pilot' })

  const supplied = Buffer.alloc(32, 1)
  const custom = await seedLinuxDeviceKey(db, { publicKey: supplied })
  assert.deepEqual(custom.publicKeyRaw, supplied)
  assert.equal(custom.privateKey, null)
  assert.equal(custom.fingerprint, createHash('sha256').update(supplied).digest('hex'))
  const defaults = (await db.query('SELECT * FROM linux_device_keys WHERE id = $1', [custom.id])).rows[0]
  assert.deepEqual([defaults.device_id, defaults.status, defaults.serial_claimed, defaults.hostname_claimed, defaults.key_backing],
    [null, 'pending', null, null, 'software'])
})

test('080 : contraintes des clés, enums et révisions ; une seule clé approuvée par poste', { skip: SKIP }, async (t) => {
  const db = await database(t)
  const device = await seedDevice(db)
  const key = await seedLinuxDeviceKey(db, { deviceId: device.id, status: 'approved' })
  await seedLinuxDeviceKey(db, { deviceId: device.id, status: 'revoked' })
  await assert.rejects(seedLinuxDeviceKey(db, { deviceId: device.id, status: 'approved' }), { code: '23505' })
  await assert.rejects(seedLinuxDeviceKey(db, { publicKey: key.publicKeyRaw }), { code: '23505' })
  await assert.rejects(seedLinuxDeviceKey(db, { publicKey: Buffer.alloc(31) }), { code: '23514' })
  for (const [column, value] of [['key_fingerprint', 'A'.repeat(64)], ['key_fingerprint', 'a'.repeat(63)], ['status', 'unknown'], ['source', 'unknown'], ['key_backing', 'unknown']]) {
    await assert.rejects(db.query(`UPDATE linux_device_keys SET ${column} = $1 WHERE id = $2`, [value, key.id]), { code: '23514' })
  }
  for (const column of ['platform', 'managed_by', 'ring']) {
    await assert.rejects(db.query(`UPDATE devices SET ${column} = 'invalide' WHERE id = $1`, [device.id]), { code: '23514' })
  }
  await db.query(`INSERT INTO linux_apply_reports (device_id, status, revision) VALUES ($1, 'success', $2), ($1, 'skipped', NULL)`, [device.id, 'a'.repeat(40)])
  for (const [status, revision] of [['invalide', null], ['success', 'a'.repeat(39)], ['failed', 'A'.repeat(40)]]) {
    await assert.rejects(db.query(`INSERT INTO linux_apply_reports (device_id, status, revision) VALUES ($1, $2, $3)`, [device.id, status, revision]), { code: '23514' })
  }
  await assert.rejects(db.query(`INSERT INTO linux_preregistrations (serial, profile, ring) VALUES ('SN', 'admin', 'invalide')`), { code: '23514' })
  await assert.rejects(db.query(`INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id) VALUES ($1, 'invalide', '/', $2, 'escrow')`, [device.id, Buffer.from('chiffré')]), { code: '23514' })
})

test('080 : effacement en cascade et préinscription conservée avec référence de clé effacée', { skip: SKIP }, async (t) => {
  const db = await database(t)
  const device = await seedDevice(db)
  const key = await seedLinuxDeviceKey(db, { deviceId: device.id })
  await db.query(`INSERT INTO linux_preregistrations (serial, hostname, profile, ring, consumed_by_key_id)
    VALUES ('SN', 'lx-test', 'admin', 'stable', $1)`, [key.id])
  await assert.rejects(db.query(`INSERT INTO linux_preregistrations (serial, profile, ring) VALUES ('SN', 'admin', 'pilot')`), { code: '23505' })
  await assert.rejects(db.query(`INSERT INTO linux_preregistrations (serial, hostname, profile, ring) VALUES ('SN2', 'lx-test', 'admin', 'pilot')`), { code: '23505' })
  await db.query(`INSERT INTO linux_apply_reports (device_id, status) VALUES ($1, 'partial')`, [device.id])
  await db.query(`INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id)
    VALUES ($1, 'luks_recovery', '/', $2, 'escrow'), ($1, 'tpm_owner', 'tpm', $2, 'escrow')`, [device.id, Buffer.from('chiffré')])
  await db.query('DELETE FROM devices WHERE id = $1', [device.id])
  for (const table of ['linux_device_keys', 'linux_apply_reports', 'device_recovery_keys']) {
    assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0, table)
  }
  const remaining = await db.query('SELECT serial, consumed_by_key_id FROM linux_preregistrations')
  assert.deepEqual(remaining.rows, [{ serial: 'SN', consumed_by_key_id: null }])
})

test('080 : colonnes historiques laissées nulles au rejeu et paramètres personnalisés conservés', { skip: SKIP }, async (t) => {
  const db = await database(t)
  const device = await seedDevice(db)
  const before = (await db.query('SELECT * FROM devices WHERE id = $1', [device.id])).rows[0]
  await db.query(`UPDATE settings SET value = '{"branch":"production"}' WHERE key = 'linux.ring.stable'`)
  const sql = await readFile(new URL('../../migrations/080_linux_fleet.sql', import.meta.url), 'utf8')
  await db.query(sql)
  await db.query(sql)
  assert.deepEqual((await db.query('SELECT * FROM devices WHERE id = $1', [device.id])).rows[0], before)
  for (const column of ['platform', 'managed_by', 'profile', 'ring', 'last_revision_applied', 'last_successful_revision', 'last_apply_status', 'last_apply_at']) {
    assert.equal(before[column], null, column)
  }
  const settings = await db.query(`SELECT key, value FROM settings WHERE key LIKE 'linux.%'`)
  assert.deepEqual(Object.fromEntries(settings.rows.map(r => [r.key, r.value])), {
    'linux.repo_url': '', 'linux.ring.pilot': '{"branch":"main"}', 'linux.ring.stable': '{"branch":"production"}',
    'linux.allowed_signers': '[]', 'linux.alerts_enabled': 'false', 'linux.escrow_backup_confirmed': '',
  })
})
