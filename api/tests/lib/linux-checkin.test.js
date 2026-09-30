// lib/checkin.js : règle de série (adoption, refus audité et limité), écritures
// de vivacité (jamais hostname / agent_version sur devices), assemblage de
// l'affectation selon l'état du miroir et de la clé d'escrow. Schéma Postgres
// réel, miroir et clé d'escrow simulés.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { insertAdminCredential } from '../fixtures/admin-credentials.js'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'
import { checkin, buildAssignment, fleetGitUrl, parseBackupConfirmation, CHECKIN_INTERVAL_S } from '../../modules/linux/lib/checkin.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)
const KEY_ID = 'f'.repeat(64)
const OTHER_KEY_ID = 'e'.repeat(64)

let db, release, tokenStore
const log = null
const mirror = { serving: true, heads: { pilot: SHA('a'), stable: SHA('b') } }
const gitMirror = { serving: () => mirror.serving, heads: () => ({ ...mirror.heads, upstream: {} }) }
const escrow = { status: 'ok', public_key_pem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n', key_id: KEY_ID, bits: 2048 }
const lapsKey = { info: () => ({ ...escrow }) }
const deps = () => ({ gitMirror, gitTokenStore: tokenStore, lapsKey, gitUrl: 'https://opale.test/api/linux/agent/git/fleet.git' })

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  tokenStore = createGitTokenStore()
})

after(async () => {
  tokenStore?.stop()
  if (release) await release()
  await closeSharedPool()
})

const body = (extra = {}) => ({
  serial: 'SN-CK-1', agent_version: '0.2.0', os_version: 'Debian GNU/Linux 12 (bookworm)', hostname: 'claimed-name',
  disk_root_pct: 41.5, luks_root: false, escrow_key_id: null, ...extra,
})

async function pullDevice(serial, extra = {}) {
  const device = await seedDevice(db, { hostname: `lx-${serial.toLowerCase()}`, serial, platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot', lastSeenMinutesAgo: 600, ...extra })
  const seeded = await seedLinuxDeviceKey(db, { deviceId: device.id, status: 'approved', serialClaimed: extra.serialClaimed === undefined ? serial : extra.serialClaimed })
  const { rows: [key] } = await db.query('SELECT id, device_id, key_fingerprint, status, serial_claimed FROM linux_device_keys WHERE id = $1', [seeded.id])
  return { device, key }
}

async function audits(keyId) {
  const { rows } = await db.query("SELECT by_user, target, details FROM audit_logs WHERE action = 'linux_key_serial_mismatch' AND details->>'key_id' = $1", [keyId])
  return rows
}

test('fleetGitUrl : origine publique FRONTEND_URL sans barre finale, chemin seul sans variable', () => {
  assert.equal(fleetGitUrl({ FRONTEND_URL: 'https://opale.example.org/' }), 'https://opale.example.org/api/linux/agent/git/fleet.git')
  assert.equal(fleetGitUrl({ FRONTEND_URL: ' https://opale.example.org ' }), 'https://opale.example.org/api/linux/agent/git/fleet.git')
  assert.equal(fleetGitUrl({}), '/api/linux/agent/git/fleet.git')
})

test('parseBackupConfirmation : vide, JSON invalide ou sans key_id → null', () => {
  assert.equal(parseBackupConfirmation(''), null)
  assert.equal(parseBackupConfirmation(undefined), null)
  assert.equal(parseBackupConfirmation('{'), null)
  assert.equal(parseBackupConfirmation('{"by":"x"}'), null)
  assert.deepEqual(parseBackupConfirmation(`{"key_id":"${KEY_ID}","by":"Admin","at":"2026-09-30T10:00:00Z"}`), { key_id: KEY_ID, by: 'Admin', at: '2026-09-30T10:00:00Z' })
})

test('buildAssignment : miroir prêt (git + token), non prêt (git null + retry_after_s), escrow_needed et rotation', () => {
  const device = { id: 'dev', hostname: 'lx-1', profile: 'field', ring: 'stable' }
  const base = {
    device, heads: mirror.heads, gitUrl: 'https://o/api/linux/agent/git/fleet.git', token: { token: 'gt_x', expiresAt: 1_700_000_000_000 },
    escrowInfo: escrow, backup: { key_id: KEY_ID }, luksRoot: true, hasCurrentRecoveryKey: true,
    credential: { rotation_requested_at: null }, escrowKeyId: KEY_ID, localAdminUsername: 'opale-admin',
  }
  const ready = buildAssignment({ ...base, mirrorReady: true })
  assert.deepEqual(ready, {
    device_id: 'dev', hostname: 'lx-1', profile: 'field', ring: 'stable', revision: SHA('b'),
    git: { url: 'https://o/api/linux/agent/git/fleet.git', token: 'gt_x', token_expires_at: '2023-11-14T22:13:20.000Z' },
    escrow: { status: 'ok', public_key_pem: escrow.public_key_pem, key_id: KEY_ID },
    escrow_needed: [], local_admin_username: 'opale-admin', rotate_local_admin: false, checkin_interval_s: CHECKIN_INTERVAL_S,
    extra_vars: { opale_profile: 'field', opale_ring: 'stable', opale_device_id: 'dev', opale_hostname: 'lx-1' },
  })
  const notReady = buildAssignment({ ...base, mirrorReady: false, token: null })
  assert.equal(notReady.git, null)
  assert.equal(notReady.retry_after_s, 60)
  assert.equal(ready.retry_after_s, undefined)

  const needs = buildAssignment({ ...base, mirrorReady: true, hasCurrentRecoveryKey: false, credential: null })
  assert.deepEqual(needs.escrow_needed, ['luks_recovery', 'local_admin'])
  const staleAdmin = buildAssignment({ ...base, mirrorReady: true, escrowKeyId: OTHER_KEY_ID, credential: { rotation_requested_at: '2026-09-30T10:00:00Z' } })
  assert.deepEqual(staleAdmin.escrow_needed, ['local_admin'], 'mot de passe escrowé sous une autre clé')
  assert.equal(staleAdmin.rotate_local_admin, true)
  assert.deepEqual(buildAssignment({ ...base, mirrorReady: true, luksRoot: false, hasCurrentRecoveryKey: false }).escrow_needed, [])
  assert.equal(buildAssignment({ ...base, mirrorReady: true, device: { ...device, ring: 'pilot' } }).revision, SHA('a'))
})

test('buildAssignment : sauvegarde non confirmée ou confirmée pour une autre clé → backup_unconfirmed (PEM toujours servi) ; clé illisible → unavailable', () => {
  const base = {
    device: { id: 'dev', hostname: 'lx', profile: 'p', ring: 'pilot' }, mirrorReady: false, heads: mirror.heads, gitUrl: '', token: null,
    escrowInfo: escrow, luksRoot: false, hasCurrentRecoveryKey: false, credential: null, escrowKeyId: null, localAdminUsername: 'u',
  }
  for (const backup of [null, { key_id: OTHER_KEY_ID }]) {
    const a = buildAssignment({ ...base, backup })
    assert.equal(a.escrow.status, 'backup_unconfirmed')
    assert.equal(a.escrow.public_key_pem, escrow.public_key_pem)
    assert.equal(a.escrow.key_id, KEY_ID)
  }
  const unavailable = buildAssignment({ ...base, backup: null, luksRoot: true, escrowInfo: { status: 'unavailable', public_key_pem: null, key_id: null } })
  assert.deepEqual(unavailable.escrow, { status: 'unavailable', public_key_pem: null, key_id: null })
  assert.deepEqual(unavailable.escrow_needed, [], 'sans clé lisible, rien à demander à l’agent')
})

test('checkin : écrit last_seen / os / disk sur devices et last_seen_at / versions / luks_root sur la clé, jamais hostname', { skip: SKIP }, async () => {
  const { device, key } = await pullDevice('SN-CK-1')
  await db.query(`INSERT INTO settings (key, value) VALUES ('agent.laps_recovery_username', 'opale-admin') ON CONFLICT (key) DO UPDATE SET value = 'opale-admin'`)
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.escrow_backup_confirmed'", [JSON.stringify({ key_id: KEY_ID, by: 'Admin', at: '2026-09-30T10:00:00Z' })])
  const result = await checkin(db, log, { key, body: body({ luks_root: true }) }, deps())
  assert.equal(result.status, 'ok')
  const a = result.assignment
  assert.equal(a.device_id, device.id)
  assert.equal(a.hostname, 'lx-sn-ck-1', 'nom du serveur, pas la revendication')
  assert.deepEqual([a.profile, a.ring, a.revision], ['field', 'pilot', SHA('a')])
  assert.equal(a.git.url, 'https://opale.test/api/linux/agent/git/fleet.git')
  const entry = tokenStore.verify(a.git.token)
  assert.deepEqual([entry.deviceId, entry.fingerprint, entry.expired], [device.id, key.key_fingerprint, false])
  assert.equal(new Date(a.git.token_expires_at).getTime(), entry.expiresAt)
  assert.equal(a.escrow.status, 'ok')
  assert.deepEqual(a.escrow_needed, ['luks_recovery', 'local_admin'])
  assert.equal(a.local_admin_username, 'opale-admin')
  assert.equal(a.rotate_local_admin, false)

  const { rows: [row] } = await db.query('SELECT hostname, os, disk_used_pct, agent_version, last_seen FROM devices WHERE id = $1', [device.id])
  assert.equal(row.hostname, 'lx-sn-ck-1')
  assert.equal(row.os, 'Debian GNU/Linux 12 (bookworm)')
  assert.equal(Number(row.disk_used_pct), 41.5)
  assert.equal(row.agent_version, null, 'la version agent vit sur la clé')
  assert.ok(Date.now() - new Date(row.last_seen).getTime() < 60_000)
  const { rows: [k] } = await db.query('SELECT agent_version, os_version, luks_root, serial_claimed, last_seen_at FROM linux_device_keys WHERE id = $1', [key.id])
  assert.deepEqual([k.agent_version, k.os_version, k.luks_root, k.serial_claimed], ['0.2.0', 'Debian GNU/Linux 12 (bookworm)', true, 'SN-CK-1'])
  assert.ok(Date.now() - new Date(k.last_seen_at).getTime() < 60_000)

  // Secret escrowé sous la clé courante et mot de passe local présent : plus rien à demander ; rotation demandée relayée.
  await db.query("INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id) VALUES ($1, 'luks_recovery', '/', '\\x00', $2)", [device.id, KEY_ID])
  await insertAdminCredential(db, { device_id: device.id, rotation_requested_at: new Date() })
  const again = (await checkin(db, log, { key, body: body({ luks_root: true, escrow_key_id: KEY_ID }) }, deps())).assignment
  assert.deepEqual(again.escrow_needed, [])
  assert.equal(again.rotate_local_admin, true)
  // Clé de récupération périmée (autre key_id) : à refaire.
  await db.query('UPDATE device_recovery_keys SET key_id = $2 WHERE device_id = $1', [device.id, OTHER_KEY_ID])
  assert.deepEqual((await checkin(db, log, { key, body: body({ luks_root: true, escrow_key_id: KEY_ID }) }, deps())).assignment.escrow_needed, ['luks_recovery'])
})

test('checkin : miroir non servi (absent, clonage) → git null + retry_after_s, aucun token émis ; sauvegarde non confirmée → backup_unconfirmed', { skip: SKIP }, async () => {
  const { key } = await pullDevice('SN-CK-2', { ring: 'stable' })
  await db.query("UPDATE settings SET value = '' WHERE key = 'linux.escrow_backup_confirmed'")
  const before = tokenStore.size()
  mirror.serving = false
  try {
    const { assignment } = await checkin(db, log, { key, body: body({ serial: 'SN-CK-2' }) }, deps())
    assert.equal(assignment.git, null)
    assert.equal(assignment.retry_after_s, 60)
    assert.equal(assignment.revision, SHA('b'), 'révision informative même sans token')
    assert.equal(assignment.escrow.status, 'backup_unconfirmed')
    assert.equal(tokenStore.size(), before)
  } finally {
    mirror.serving = true
  }
})

test('checkin : série inconnue à l’enrôlement adoptée ; série différente → refus audité une fois par heure, sans écriture', { skip: SKIP }, async () => {
  const { device, key } = await pullDevice('SN-CK-3', { serialClaimed: null })
  const adopted = await checkin(db, log, { key, body: body({ serial: ' sn-ck-3 ' }) }, deps())
  assert.equal(adopted.status, 'ok')
  const { rows: [k] } = await db.query('SELECT serial_claimed FROM linux_device_keys WHERE id = $1', [key.id])
  assert.equal(k.serial_claimed, 'SN-CK-3', 'normalisée')

  const stored = { ...key, serial_claimed: 'SN-CK-3' }
  await db.query("UPDATE devices SET os = 'avant' WHERE id = $1", [device.id])
  const first = await checkin(db, log, { key: stored, body: body({ serial: 'SN-CLONE', os_version: 'après' }) }, deps())
  assert.deepEqual(first, { status: 'serial_mismatch' })
  const second = await checkin(db, log, { key: stored, body: body({ serial: 'SN-CLONE' }) }, deps())
  assert.deepEqual(second, { status: 'serial_mismatch' })
  const rows = await audits(key.id)
  assert.equal(rows.length, 1, 'audit limité à un par clé et par heure')
  assert.equal(rows[0].by_user, 'device:' + key.key_fingerprint.slice(0, 12))
  assert.equal(rows[0].target, device.id)
  assert.deepEqual(rows[0].details, { level: 'warn', key_id: key.id, serial: 'SN-CLONE', expected: 'SN-CK-3', hostname: 'claimed-name' })
  const { rows: [untouched] } = await db.query('SELECT os FROM devices WHERE id = $1', [device.id])
  assert.equal(untouched.os, 'avant', 'aucune écriture sur refus')
  // Série bidon présentée : pas un refus (comparée seulement quand réelle).
  assert.equal((await checkin(db, log, { key: stored, body: body({ serial: 'To be filled by O.E.M.' }) }, deps())).status, 'ok')
})
