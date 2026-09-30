// lib/enrollment.js : machine à états de l'enrôlement Linux sur un schéma
// Postgres réel — contact d'un agent (pending / auto-approbation / conflits /
// plafond), approbation (nouveau, conversion, ré-enrôlement, lot), rejet,
// révocation. Les lignes d'audit sont vérifiées à chaque transition.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { seedAdmin } from '../fixtures/users.js'
import {
  classifyEnrollment, enrollDevice, approveEnrollment, approveEnrollments,
  rejectEnrollment, rejectEnrollments, revokeDeviceKey, PENDING_CAP,
} from '../../modules/linux/lib/enrollment.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let db, release
const log = null

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  await seedAdmin(db, { entraId: 'oid-user-lx', displayName: 'Utilisateur Lx', email: 'lx@test.local' })
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// Un agent = une clé aléatoire ; l'octet brut suffit ici (pas de signature).
function agent(serial, hostname = 'debian') {
  const publicKeyRaw = randomBytes(32)
  const fingerprint = createHash('sha256').update(publicKeyRaw).digest('hex')
  return { fingerprint, publicKeyRaw, keyBacking: 'software', serialClaimed: serial, hostnameClaimed: hostname, osVersion: 'Debian 12', agentVersion: '0.1.0', ip: '203.0.113.9' }
}

async function key(id) {
  const { rows: [row] } = await db.query('SELECT * FROM linux_device_keys WHERE id = $1', [id])
  return row
}

async function audits(action, target = null) {
  const { rows } = await db.query(
    `SELECT by_user, target, details FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target = $2) ORDER BY created_at, id`,
    [action, target]
  )
  return rows
}

async function prereg(serial, extra = {}) {
  const { rows: [row] } = await db.query(`
    INSERT INTO linux_preregistrations (serial, hostname, profile, ring, assigned_user_id, created_by)
    VALUES ($1, $2, $3, $4, $5, 'test') RETURNING *
  `, [serial, extra.hostname ?? null, extra.profile ?? 'field', extra.ring ?? 'pilot', extra.assignedUserId ?? null])
  return row
}

// ─── enrollDevice ─────────────────────────────────────────────────────────────

test('enrollDevice — matériel inconnu : pending, code et relance 30 s, aucun audit', { skip: SKIP }, async () => {
  const a = agent('sn-new-001')
  const first = await enrollDevice(db, log, a)
  assert.equal(first.status, 'pending')
  assert.equal(first.retryAfterS, 30)
  assert.equal(first.key.serial_claimed, 'SN-NEW-001', 'série normalisée')
  assert.equal(first.key.enroll_attempts, 1)
  assert.equal(first.key.conflict, null)
  const again = await enrollDevice(db, log, { ...a, hostnameClaimed: 'debian-2', agentVersion: '0.2.0' })
  assert.equal(again.status, 'pending')
  assert.equal(again.key.enroll_attempts, 2)
  assert.equal(again.key.hostname_claimed, 'debian-2', 'revendications rafraîchies')
  assert.equal(again.key.agent_version, '0.2.0')
  assert.equal((await audits('linux_enroll_serial_conflict')).length, 0)
  assert.equal((await classifyEnrollment(db, { fingerprint: a.fingerprint, serialNormalized: null })).kind, 'new')
})

test('enrollDevice — relance après la première heure : 300 s', { skip: SKIP }, async () => {
  const a = agent('sn-old-001')
  const { key: k } = await enrollDevice(db, log, a)
  await db.query("UPDATE linux_device_keys SET first_seen_at = now() - interval '61 minutes' WHERE id = $1", [k.id])
  assert.equal((await enrollDevice(db, log, a)).retryAfterS, 300)
})

test('enrollDevice — série pré-inscrite et matériel neuf : auto-approbation avec le nom, le profil et l’utilisateur réservés', { skip: SKIP }, async () => {
  const p = await prereg('SN-PRE-001', { hostname: 'lx-dupont', profile: 'admin', ring: 'stable', assignedUserId: 'oid-user-lx' })
  const a = agent(' sn-pre-001 ')
  const result = await enrollDevice(db, log, a)
  assert.equal(result.status, 'approved')
  assert.equal(result.device.hostname, 'lx-dupont')
  assert.equal(result.device.platform, 'linux')
  assert.equal(result.device.managed_by, 'pull')
  assert.equal(result.device.profile, 'admin')
  assert.equal(result.device.ring, 'stable')
  assert.equal(result.device.assigned_user_id, 'oid-user-lx')
  assert.equal(result.device.serial, 'SN-PRE-001')
  assert.equal(result.key.status, 'approved')
  assert.equal(result.key.source, 'preregistration')
  assert.equal(result.key.device_id, result.device.id)
  const { rows: [consumed] } = await db.query('SELECT consumed_at, consumed_by_key_id FROM linux_preregistrations WHERE id = $1', [p.id])
  assert.ok(consumed.consumed_at)
  assert.equal(consumed.consumed_by_key_id, result.key.id)
  const [row] = await audits('linux_device_enrolled', result.device.id)
  assert.equal(row.by_user, 'device:' + a.fingerprint.slice(0, 12))
  assert.equal(row.details.source, 'preregistration')
  // Relance de la clé approuvée : même poste, aucune nouvelle ligne.
  const again = await enrollDevice(db, log, a)
  assert.equal(again.status, 'approved')
  assert.equal(again.device.id, result.device.id)
})

test('enrollDevice — série pré-inscrite sans nom : lx-<série>', { skip: SKIP }, async () => {
  await prereg('SN-PRE-002')
  const result = await enrollDevice(db, log, agent('SN-PRE-002'))
  assert.equal(result.status, 'approved')
  assert.equal(result.device.hostname, 'lx-sn-pre-002')
})

test('enrollDevice — série d’un poste Windows : pending avec conflit existing_device, réservation conservée, audit une seule fois', { skip: SKIP }, async () => {
  const win = await seedDevice(db, { hostname: 'PC-DUPONT', serial: 'SN-WIN-001' })
  await db.query("UPDATE devices SET platform = 'windows' WHERE id = $1", [win.id])
  const token = await seedAgentToken(db, { deviceId: win.id })
  await db.query('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1', [token.id])
  const p = await prereg('SN-WIN-001', { hostname: 'PC-DUPONT' })
  const a = agent('sn-win-001')
  const result = await enrollDevice(db, log, a)
  assert.equal(result.status, 'pending')
  assert.deepEqual({ ...result.key.conflict, last_seen: undefined }, {
    kind: 'existing_device', device_id: win.id, hostname: 'PC-DUPONT', managed_by: null, platform: 'windows',
    key_id: null, has_active_token: true, last_seen: undefined,
  })
  const { rows: [open] } = await db.query('SELECT consumed_at FROM linux_preregistrations WHERE id = $1', [p.id])
  assert.equal(open.consumed_at, null, 'pré-inscription non consommée')
  await enrollDevice(db, log, a)
  const rows = await audits('linux_enroll_serial_conflict', win.id)
  assert.equal(rows.length, 1, 'un seul audit pour deux contacts')
  assert.equal(rows[0].by_user, 'device:' + a.fingerprint.slice(0, 12))
  assert.equal(rows[0].details.level, 'warn')
  assert.equal(rows[0].details.conflict.kind, 'existing_device')
})

test('enrollDevice — série d’un poste pull : conflit reimage avec la clé active ; clé approuvée orpheline : clone', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-reimage', serial: 'SN-PULL-001', platform: 'linux', managed_by: 'pull' })
  const active = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-PULL-001' })
  const reimage = await enrollDevice(db, log, agent('SN-PULL-001'))
  assert.equal(reimage.status, 'pending')
  assert.equal(reimage.key.conflict.kind, 'reimage')
  assert.equal(reimage.key.conflict.device_id, pull.id)
  assert.equal(reimage.key.conflict.key_id, active.id)
  assert.equal(reimage.key.conflict.has_active_token, false)

  const orphan = await seedLinuxDeviceKey(db, { status: 'approved', serialClaimed: 'SN-CLONE-001' })
  const clone = await enrollDevice(db, log, agent('SN-CLONE-001'))
  assert.equal(clone.status, 'pending')
  assert.equal(clone.key.conflict.kind, 'clone')
  assert.equal(clone.key.conflict.key_id, orphan.id)
  assert.equal(clone.key.conflict.device_id, null)
})

test('enrollDevice — clé rejetée ou révoquée : statut renvoyé, tentative comptée', { skip: SKIP }, async () => {
  for (const status of ['rejected', 'revoked']) {
    const a = agent(`SN-${status}`)
    const { key: k } = await enrollDevice(db, log, a)
    await db.query('UPDATE linux_device_keys SET status = $2 WHERE id = $1', [k.id, status])
    const result = await enrollDevice(db, log, a)
    assert.equal(result.status, status)
    assert.equal(result.key.enroll_attempts, 2)
  }
})

test('enrollDevice — clé approuvée avec une autre série : serial_mismatch audité (1/h par clé) ; série inconnue adoptée', { skip: SKIP }, async () => {
  await prereg('SN-MM-001')
  const a = agent('SN-MM-001')
  const approved = await enrollDevice(db, log, a)
  assert.equal(approved.status, 'approved')
  const mismatch = await enrollDevice(db, log, { ...a, serialClaimed: 'SN-OTHER' })
  assert.equal(mismatch.status, 'serial_mismatch')
  assert.equal(mismatch.key.serial_claimed, 'SN-MM-001', 'série approuvée conservée')
  // Relance immédiate : même résultat, tentative comptée, pas de nouvel audit.
  const again = await enrollDevice(db, log, { ...a, serialClaimed: 'SN-OTHER' })
  assert.equal(again.status, 'serial_mismatch')
  assert.equal(again.key.enroll_attempts, 3)
  const rows = await audits('linux_key_serial_mismatch', approved.device.id)
  assert.equal(rows.length, 1, 'un seul audit pour deux relances dans l’heure')
  const [row] = rows
  assert.equal(row.details.level, 'warn')
  assert.equal(row.details.key_id, mismatch.key.id)
  assert.equal(row.details.serial, 'SN-OTHER')
  assert.equal(row.details.expected, 'SN-MM-001')
  await db.query("UPDATE audit_logs SET created_at = now() - interval '2 hours' WHERE action = 'linux_key_serial_mismatch' AND details->>'key_id' = $1", [mismatch.key.id])
  await enrollDevice(db, log, { ...a, serialClaimed: 'SN-OTHER' })
  assert.equal((await audits('linux_key_serial_mismatch', approved.device.id)).length, 2, 'audité à nouveau après une heure')

  // Clé approuvée sans série réelle (bidon à l'enrôlement) : adopte la première série vue.
  const noSerial = await seedLinuxDeviceKey(db, { deviceId: approved.device.id, status: 'revoked' })
  await db.query("UPDATE linux_device_keys SET status = 'approved', device_id = NULL WHERE id = $1", [noSerial.id])
  const adopt = await enrollDevice(db, log, { ...agent('SN-ADOPT'), fingerprint: noSerial.fingerprint, publicKeyRaw: noSerial.publicKeyRaw })
  assert.equal(adopt.status, 'approved')
  assert.equal(adopt.key.serial_claimed, 'SN-ADOPT')
})

test('enrollDevice — plafond de demandes en attente : flood audité, relances des clés connues jamais bloquées', { skip: SKIP }, async () => {
  const known = agent('SN-KNOWN-FLOOD')
  await enrollDevice(db, log, known)
  const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM linux_device_keys WHERE status = 'pending'")
  await db.query(`
    INSERT INTO linux_device_keys (key_fingerprint, public_key, key_backing, serial_claimed)
    SELECT md5('flood-a-' || i) || md5('flood-b-' || i), decode(md5('pk-a-' || i) || md5('pk-b-' || i), 'hex'), 'software', 'SN-FLOOD-' || i
    FROM generate_series(1, $1) AS i
  `, [PENDING_CAP - n])
  const a = agent('SN-FLOOD-NEW')
  const flood = await enrollDevice(db, log, a)
  assert.equal(flood.status, 'flood')
  assert.equal(flood.retryAfterS, 300)
  const { rowCount } = await db.query('SELECT 1 FROM linux_device_keys WHERE key_fingerprint = $1', [a.fingerprint])
  assert.equal(rowCount, 0, 'aucune ligne créée')
  const [row] = await audits('linux_enroll_flood')
  assert.equal(row.by_user, 'device:' + a.fingerprint.slice(0, 12))
  assert.equal(row.details.level, 'error')
  assert.equal(row.details.pending, PENDING_CAP)
  const again = await enrollDevice(db, log, known)
  assert.equal(again.status, 'pending')
  assert.equal(again.key.enroll_attempts, 2)
  await db.query("DELETE FROM linux_device_keys WHERE serial_claimed LIKE 'SN-FLOOD-%'")
})

// ─── approveEnrollment ────────────────────────────────────────────────────────

test('approveEnrollment — nouveau poste : ligne devices, clé liée, audit ; puis NOT_PENDING', { skip: SKIP }, async () => {
  const { key: k } = await enrollDevice(db, log, agent('SN-APP-001'))
  const result = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', assigned_user_id: 'oid-user-lx' })
  assert.equal(result.ok, true)
  assert.equal(result.converted, false)
  assert.equal(result.device.hostname, 'lx-sn-app-001')
  assert.equal(result.device.platform, 'linux')
  assert.equal(result.device.managed_by, 'pull')
  assert.equal(result.device.source, 'agent')
  assert.equal(result.device.assigned_user_id, 'oid-user-lx')
  const stored = await key(k.id)
  assert.equal(stored.status, 'approved')
  assert.equal(stored.device_id, result.device.id)
  assert.equal(stored.approved_by, 'Admin')
  assert.equal(stored.source, 'manual')
  const [row] = await audits('linux_device_approved', result.device.id)
  assert.equal(row.by_user, 'Admin')
  assert.equal(row.details.key_id, k.id)
  const again = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot' })
  assert.deepEqual([again.ok, again.status, again.code], [false, 409, 'NOT_PENDING'])
  const missing = await approveEnrollment(db, log, 'Admin', '00000000-0000-4000-8000-000000000000', { profile: 'field', ring: 'pilot' })
  assert.deepEqual([missing.status, missing.code], [404, 'NOT_FOUND'])
})

test('approveEnrollment — nom explicite, HOSTNAME_TAKEN et UNKNOWN_USER', { skip: SKIP }, async () => {
  await seedDevice(db, { hostname: 'lx-taken' })
  const { key: k } = await enrollDevice(db, log, agent('SN-APP-002'))
  const taken = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', hostname: 'lx-taken' })
  assert.deepEqual([taken.status, taken.code], [409, 'HOSTNAME_TAKEN'])
  assert.equal((await key(k.id)).status, 'pending', 'transaction annulée')
  const unknown = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', assigned_user_id: 'oid-nobody' })
  assert.deepEqual([unknown.status, unknown.code], [400, 'UNKNOWN_USER'])
  const ok = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', hostname: 'lx-explicit' })
  assert.equal(ok.device.hostname, 'lx-explicit')
})

test('approveEnrollment — conversion d’un poste Windows : CONFLICT sans cible, ACTIVE_TOKEN, puis faits effacés et historique conservé', { skip: SKIP }, async () => {
  const win = await seedDevice(db, { hostname: 'PC-CONVERT', serial: 'SN-CONV-001', ipNetbird: '100.64.0.9' })
  await db.query(`UPDATE devices SET platform = 'windows', agent_version = '2.15.3', intune_device_id = 'intune-1',
    health_signals = '{"a":1}', system_info = '{"current_user":"x"}', compliance_state = 'compliant', assigned_user_id = 'oid-user-lx' WHERE id = $1`, [win.id])
  await db.query('INSERT INTO disks (device_id, letter) VALUES ($1, $2)', [win.id, 'C:'])
  await db.query('INSERT INTO network_interfaces (device_id, adapter) VALUES ($1, $2)', [win.id, 'eth0'])
  await db.query("INSERT INTO compliance_results (device_id, rule_id, status, severity) VALUES ($1, 'bitlocker', 'pass', 'critical')", [win.id])
  const { rows: [ticket] } = await db.query("INSERT INTO tickets (title, device_id) VALUES ('Souris cassée', $1) RETURNING id", [win.id])
  const { rows: [group] } = await db.query("INSERT INTO groups (name) VALUES ('Migration') RETURNING id")
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2)', [group.id, win.id])
  const token = await seedAgentToken(db, { deviceId: win.id })
  await db.query('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1', [token.id])

  const { key: k } = await enrollDevice(db, log, agent('SN-CONV-001', 'debian-conv'))
  assert.equal(k.conflict.kind, 'existing_device')
  const noTarget = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot' })
  assert.deepEqual([noTarget.status, noTarget.code], [409, 'CONFLICT'])
  const active = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', convert_device_id: win.id })
  assert.deepEqual([active.status, active.code], [409, 'ACTIVE_TOKEN'])
  assert.equal(active.details.token_id, token.id)
  const { rows: [untouched] } = await db.query('SELECT managed_by, agent_version FROM devices WHERE id = $1', [win.id])
  assert.deepEqual(untouched, { managed_by: null, agent_version: '2.15.3' }, 'refus sans mutation')

  const result = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'stable', convert_device_id: win.id, revoke_active_token: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.converted, true)
  assert.equal(result.device.id, win.id, 'même ligne devices')
  assert.equal(result.device.hostname, 'PC-CONVERT', 'nom existant conservé')
  assert.equal(result.device.platform, 'linux')
  assert.equal(result.device.managed_by, 'pull')
  assert.equal(result.device.ring, 'stable')
  assert.equal(result.device.assigned_user_id, 'oid-user-lx', 'utilisateur existant conservé')
  for (const field of ['agent_version', 'intune_device_id', 'health_signals', 'system_info', 'compliance_state', 'ip_netbird']) {
    assert.equal(result.device[field], null, `${field} effacé`)
  }
  const { rows: [tok] } = await db.query('SELECT revoked_at FROM agent_tokens WHERE id = $1', [token.id])
  assert.ok(tok.revoked_at, 'token legacy révoqué')
  for (const table of ['disks', 'network_interfaces', 'compliance_results']) {
    const { rowCount } = await db.query(`SELECT 1 FROM ${table} WHERE device_id = $1`, [win.id])
    assert.equal(rowCount, 0, `${table} vidée`)
  }
  const { rows: [t] } = await db.query('SELECT device_id FROM tickets WHERE id = $1', [ticket.id])
  assert.equal(t.device_id, win.id, 'ticket toujours rattaché')
  const { rowCount: member } = await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND device_id = $2', [group.id, win.id])
  assert.equal(member, 1, 'appartenance au groupe conservée')
  const [row] = await audits('linux_device_converted', win.id)
  assert.equal(row.by_user, 'Admin')
  assert.deepEqual(row.details.cleared, { compliance_results: 1, disks: 1, network_interfaces: 1, device_software: 0, agent_tokens: 1 })
  assert.equal(row.details.revoke_active_token, true)
  assert.equal((await key(k.id)).device_id, win.id)
})

test('approveEnrollment — convert_device_id vers un poste d’une autre série : SERIAL_MISMATCH', { skip: SKIP }, async () => {
  const other = await seedDevice(db, { hostname: 'PC-OTHER-SERIAL', serial: 'SN-OTHER-999' })
  const { key: k } = await enrollDevice(db, log, agent('SN-MISMATCH-001'))
  const result = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot', convert_device_id: other.id })
  assert.deepEqual([result.status, result.code], [409, 'SERIAL_MISMATCH'])
  const { rows: [untouched] } = await db.query('SELECT managed_by FROM devices WHERE id = $1', [other.id])
  assert.equal(untouched.managed_by, null)
})

test('approveEnrollment — ré-image d’un poste pull : ACTIVE_KEY, puis supersede révoque l’ancienne clé et relie la ligne', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-reenroll', serial: 'SN-RE-001', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const old = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-RE-001' })
  const { key: k } = await enrollDevice(db, log, agent('SN-RE-001'))
  assert.equal(k.conflict.kind, 'reimage')
  const refused = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot' })
  assert.deepEqual([refused.status, refused.code], [409, 'ACTIVE_KEY'])
  assert.equal(refused.details.old_key, old.id)
  assert.equal(refused.details.hostname, 'lx-reenroll')
  const result = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'admin', ring: 'stable', supersede: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.converted, false)
  assert.equal(result.device.id, pull.id)
  assert.equal(result.device.hostname, 'lx-reenroll')
  assert.equal(result.device.profile, 'admin')
  const previous = await key(old.id)
  assert.equal(previous.status, 'revoked')
  assert.equal(previous.revoke_reason, 'superseded')
  assert.equal(previous.revoked_by, 'Admin')
  assert.equal((await key(k.id)).device_id, pull.id)
  assert.equal((await audits('linux_device_reenrolled', pull.id)).length, 1)
  // Poste pull sans clé vivante (perdue / révoquée) : rattachement direct.
  const lost = await enrollDevice(db, log, agent('SN-RE-001'))
  await db.query("UPDATE linux_device_keys SET status = 'revoked' WHERE id = $1", [k.id])
  const direct = await approveEnrollment(db, log, 'Admin', lost.key.id, { profile: 'admin', ring: 'stable' })
  assert.equal(direct.ok, true, JSON.stringify(direct))
  assert.equal(direct.device.id, pull.id)
})

test('approveEnrollment — clone (clé approuvée orpheline) refusé : CONFLICT', { skip: SKIP }, async () => {
  await seedLinuxDeviceKey(db, { status: 'approved', serialClaimed: 'SN-CLONE-002' })
  const { key: k } = await enrollDevice(db, log, agent('SN-CLONE-002'))
  const result = await approveEnrollment(db, log, 'Admin', k.id, { profile: 'field', ring: 'pilot' })
  assert.deepEqual([result.status, result.code], [409, 'CONFLICT'])
  assert.equal(result.details.kind, 'clone')
})

test('approveEnrollments — matériels neufs et pré-inscrits en file approuvés ; conflits, doublons de nom et statuts signalés', { skip: SKIP }, async () => {
  const a = (await enrollDevice(db, log, agent('SN-BULK-A'))).key
  const b = (await enrollDevice(db, log, agent(null))).key
  const win = await seedDevice(db, { hostname: 'PC-BULK-WIN', serial: 'SN-BULK-WIN' })
  const conflict = (await enrollDevice(db, log, agent('SN-BULK-WIN'))).key
  const dup1 = (await enrollDevice(db, log, agent('SN-BULK-DUP'))).key
  const dup2 = (await enrollDevice(db, log, agent('SN-BULK-DUP'))).key
  const rejected = (await enrollDevice(db, log, agent('SN-BULK-REJ'))).key
  await rejectEnrollment(db, log, 'Admin', rejected.id)
  // Pré-inscription importée après le premier contact : la ligne est restée
  // en file sans conflit ; le lot l'approuve avec le nom et l'utilisateur réservés.
  const late = (await enrollDevice(db, log, agent('SN-BULK-PRE'))).key
  const reservation = await prereg('SN-BULK-PRE', { hostname: 'lx-bulk-pre', assignedUserId: 'oid-user-lx' })
  const result = await approveEnrollments(db, log, 'Admin', {
    ids: [a.id, b.id, conflict.id, dup1.id, dup2.id, rejected.id, '00000000-0000-4000-8000-000000000000', a.id, late.id],
    profile: 'field', ring: 'pilot',
  })
  assert.equal(result.ok, 3)
  assert.equal(result.skipped, 5)
  const lateKey = await key(late.id)
  assert.equal(lateKey.status, 'approved')
  assert.equal(lateKey.source, 'preregistration')
  const { rows: [lateDevice] } = await db.query('SELECT hostname, assigned_user_id FROM devices WHERE id = $1', [lateKey.device_id])
  assert.deepEqual(lateDevice, { hostname: 'lx-bulk-pre', assigned_user_id: 'oid-user-lx' })
  const { rows: [consumed] } = await db.query('SELECT consumed_by_key_id FROM linux_preregistrations WHERE id = $1', [reservation.id])
  assert.equal(consumed.consumed_by_key_id, late.id, 'pré-inscription consommée')
  assert.deepEqual(Object.fromEntries(result.errors.map(e => [e.id, e.code])), {
    [conflict.id]: 'CONFLICT', [dup1.id]: 'HOSTNAME_TAKEN', [dup2.id]: 'HOSTNAME_TAKEN',
    [rejected.id]: 'NOT_PENDING', '00000000-0000-4000-8000-000000000000': 'NOT_FOUND',
  })
  assert.equal((await key(a.id)).status, 'approved')
  const { rows: [bDevice] } = await db.query('SELECT hostname FROM devices WHERE id = $1', [(await key(b.id)).device_id])
  assert.equal(bDevice.hostname, 'lx-' + b.key_fingerprint.slice(0, 12), 'sans série : lx-<empreinte>')
  const { rows: [untouched] } = await db.query('SELECT managed_by FROM devices WHERE id = $1', [win.id])
  assert.equal(untouched.managed_by, null)
})

// ─── rejectEnrollment / revokeDeviceKey ───────────────────────────────────────

test('rejectEnrollment — pending → rejected avec audit ; NOT_PENDING ensuite ; lot', { skip: SKIP }, async () => {
  const { key: k } = await enrollDevice(db, log, agent('SN-REJ-001', 'debian-rej'))
  const result = await rejectEnrollment(db, log, 'Admin', k.id, 'matériel inconnu')
  assert.equal(result.ok, true)
  assert.equal(result.key.status, 'rejected')
  assert.equal(result.key.rejected_by, 'Admin')
  const row = (await audits('linux_device_rejected')).find(r => r.details.key_id === k.id)
  assert.equal(row.by_user, 'Admin')
  assert.equal(row.details.reason, 'matériel inconnu')
  assert.equal(row.details.hostname, 'debian-rej')
  const again = await rejectEnrollment(db, log, 'Admin', k.id)
  assert.deepEqual([again.status, again.code], [409, 'NOT_PENDING'])
  const other = (await enrollDevice(db, log, agent('SN-REJ-002'))).key
  const bulk = await rejectEnrollments(db, log, 'Admin', { ids: [other.id, k.id, other.id] })
  assert.deepEqual(bulk, { ok: 1, skipped: 1, errors: [{ id: k.id, code: 'NOT_PENDING' }] })
})

test('revokeDeviceKey — clé approuvée révoquée avec motif, ligne conservée ; NO_ACTIVE_KEY ; poste non pull : NOT_FOUND', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-revoke', serial: 'SN-REV-001', platform: 'linux', managed_by: 'pull' })
  const k = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-REV-001' })
  const result = await revokeDeviceKey(db, log, 'Admin', pull.id, 'Poste volé')
  assert.equal(result.ok, true)
  assert.equal(result.key.status, 'revoked')
  assert.equal(result.key.revoke_reason, 'Poste volé')
  assert.equal(result.key.revoked_by, 'Admin')
  const { rowCount } = await db.query('SELECT 1 FROM devices WHERE id = $1', [pull.id])
  assert.equal(rowCount, 1, 'ligne devices conservée')
  const [row] = await audits('linux_device_revoked', pull.id)
  assert.equal(row.details.key_id, k.id)
  assert.equal(row.details.reason, 'Poste volé')
  const none = await revokeDeviceKey(db, log, 'Admin', pull.id, 'Encore')
  assert.deepEqual([none.status, none.code], [409, 'NO_ACTIVE_KEY'])
  const win = await seedDevice(db, { hostname: 'PC-NOT-PULL' })
  const notPull = await revokeDeviceKey(db, log, 'Admin', win.id, 'Motif')
  assert.deepEqual([notPull.status, notPull.code], [404, 'NOT_FOUND'])
})
