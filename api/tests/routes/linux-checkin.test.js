// POST /api/linux/agent/checkin (docs/linux-fleet-design.md §4) : clé
// approuvée seulement, réponse conforme au schéma Assignment, token git
// vérifiable, écritures de vivacité, refus de série, états d'escrow et
// limite par poste. Miroir simulé, clé LAPS temporaire, base réelle.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { checkin } from '../helpers/linux-agent.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'
import { loadSpec, deref } from '../../modules/linux/lib/spec.js'
import { lapsKeyId } from '../../modules/inventory/lib/laps-key.js'
import agentRoutes from '../../modules/linux/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)

let db, release, app, tokenStore, tmpDir, keyPath, validate
const prevEnv = { FRONTEND_URL: process.env.FRONTEND_URL, LAPS_PRIVATE_KEY: process.env.LAPS_PRIVATE_KEY }
const mirror = { serving: true }
const gitMirror = { serving: () => mirror.serving, heads: () => ({ pilot: SHA('a'), stable: SHA('b'), upstream: {} }) }

before(async () => {
  if (SKIP) return
  process.env.FRONTEND_URL = 'https://opale.test/'
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-checkin-'))
  keyPath = path.join(tmpDir, 'laps.key')
  await fs.writeFile(keyPath, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  // La clé n'est pointée qu'après le premier test (escrow indisponible).
  process.env.LAPS_PRIVATE_KEY = path.join(tmpDir, 'absente.key')
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  tokenStore = createGitTokenStore()
  app = await buildApp({
    db, registerAuth: false, decorators: { gitMirror, gitTokenStore: tokenStore },
    routes: f => f.register(agentRoutes, { prefix: '/api/linux/agent' }),
  })
  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validate = ajv.compile(deref(loadSpec().components.schemas.Assignment))
})

after(async () => {
  if (app) await app.close()
  tokenStore?.stop()
  if (release) await release()
  await closeSharedPool()
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

let ipSeq = 0
const nextIp = () => `203.0.113.${++ipSeq}`

// Poste pull approuvé et son agent signataire (même forme que newAgent()).
async function approvedAgent(serial, { hostname = `lx-${serial.toLowerCase()}`, ...device } = {}) {
  const row = await seedDevice(db, { hostname, serial, platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot', lastSeenMinutesAgo: 600, ...device })
  const key = await seedLinuxDeviceKey(db, { deviceId: row.id, status: 'approved', serialClaimed: serial })
  return {
    device: row, key,
    privateKey: key.privateKey, fingerprint: key.fingerprint,
    body: { serial, hostname: 'claimed-by-agent', os_version: 'Debian GNU/Linux 12 (bookworm)', agent_version: '0.2.0' },
  }
}

const assertAssignment = body => assert.ok(validate(body), JSON.stringify(validate.errors))

test('/checkin — clé pending → 401 NOT_APPROVED ; sans signature → 401 ; corps hors schéma → 400', { skip: SKIP }, async () => {
  const pending = await seedLinuxDeviceKey(db, { status: 'pending', serialClaimed: 'SN-CK-PENDING' })
  const agent = { ...pending, body: { serial: 'SN-CK-PENDING', hostname: 'x', os_version: 'Debian', agent_version: '0.1.0' } }
  const res = await checkin(app, agent, { ip: nextIp() })
  assert.equal(res.statusCode, 401, res.body)
  assert.equal(res.json().code, 'NOT_APPROVED')
  const bare = await app.inject({ method: 'POST', url: '/api/linux/agent/checkin', remoteAddress: nextIp(), payload: agent.body })
  assert.equal(bare.statusCode, 401)
  const approved = await approvedAgent('SN-CK-SCHEMA')
  const invalid = await checkin(app, approved, { ip: nextIp(), body: { luks_root: undefined } })
  assert.equal(invalid.statusCode, 400, invalid.body)
})

test('/checkin — clé LAPS illisible : 200 quand même, escrow unavailable, PEM null', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-CK-NOKEY')
  const res = await checkin(app, agent, { ip: nextIp(), body: { luks_root: true } })
  assert.equal(res.statusCode, 200, res.body)
  assertAssignment(res.json())
  assert.deepEqual(res.json().escrow, { status: 'unavailable', public_key_pem: null, key_id: null })
  process.env.LAPS_PRIVATE_KEY = keyPath
})

test('/checkin — 200 conforme à Assignment : token git vérifiable, URL publique, écritures devices/clé sans hostname', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-CK-OK', { ring: 'stable' })
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.escrow_backup_confirmed'", [JSON.stringify({ key_id: lapsKeyId(), by: 'Admin', at: '2026-09-30T10:00:00Z' })])
  const res = await checkin(app, agent, { ip: nextIp(), body: { disk_root_pct: 63.2, luks_root: true, kernel: '6.1.0-25-amd64', uptime_s: 12 } })
  assert.equal(res.statusCode, 200, res.body)
  const a = res.json()
  assertAssignment(a)
  assert.equal(a.device_id, agent.device.id)
  assert.equal(a.hostname, 'lx-sn-ck-ok')
  assert.deepEqual([a.profile, a.ring, a.revision], ['field', 'stable', SHA('b')])
  assert.equal(a.git.url, 'https://opale.test/api/linux/agent/git/fleet.git')
  const entry = tokenStore.verify(a.git.token)
  assert.equal(entry.deviceId, agent.device.id)
  assert.equal(entry.fingerprint, agent.fingerprint)
  assert.equal(entry.expired, false)
  assert.ok(Date.parse(a.git.token_expires_at) - Date.now() > 590_000)
  assert.equal(a.escrow.status, 'ok')
  assert.equal(a.escrow.key_id, lapsKeyId())
  assert.match(a.escrow.public_key_pem, /^-----BEGIN PUBLIC KEY-----/)
  assert.deepEqual(a.escrow_needed, ['luks_recovery', 'local_admin'])
  assert.equal(a.local_admin_username, 'opale-recovery')
  assert.equal(a.checkin_interval_s, 900)
  assert.equal(a.retry_after_s, undefined)
  assert.deepEqual(a.extra_vars, { opale_profile: 'field', opale_ring: 'stable', opale_device_id: agent.device.id, opale_hostname: 'lx-sn-ck-ok' })

  const { rows: [device] } = await db.query('SELECT hostname, os, disk_used_pct, agent_version, last_seen FROM devices WHERE id = $1', [agent.device.id])
  assert.equal(device.hostname, 'lx-sn-ck-ok', 'jamais la revendication de l’agent')
  assert.equal(device.os, 'Debian GNU/Linux 12 (bookworm)')
  assert.equal(Number(device.disk_used_pct), 63.2)
  assert.equal(device.agent_version, null)
  assert.ok(Date.now() - new Date(device.last_seen).getTime() < 60_000)
  const { rows: [key] } = await db.query('SELECT agent_version, os_version, luks_root FROM linux_device_keys WHERE id = $1', [agent.key.id])
  assert.deepEqual(key, { agent_version: '0.2.0', os_version: 'Debian GNU/Linux 12 (bookworm)', luks_root: true })
})

test('/checkin — miroir non servi (clonage) : git null + retry_after_s, aucun token ; sauvegarde non confirmée → backup_unconfirmed', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-CK-NOTREADY')
  await db.query("UPDATE settings SET value = '' WHERE key = 'linux.escrow_backup_confirmed'")
  const size = tokenStore.size()
  mirror.serving = false
  try {
    const res = await checkin(app, agent, { ip: nextIp() })
    assert.equal(res.statusCode, 200, res.body)
    const a = res.json()
    assertAssignment(a)
    assert.equal(a.git, null)
    assert.equal(a.retry_after_s, 60)
    assert.equal(a.escrow.status, 'backup_unconfirmed')
    assert.ok(a.escrow.public_key_pem, 'PEM servi pour l’escrow du compte local')
    assert.equal(tokenStore.size(), size)
  } finally {
    mirror.serving = true
  }
})

test('/checkin — série différente de celle enrôlée → 403 SERIAL_MISMATCH audité, poste non touché', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-CK-MM')
  const res = await checkin(app, agent, { ip: nextIp(), body: { serial: 'SN-CK-OTHER' } })
  assert.equal(res.statusCode, 403, res.body)
  assert.deepEqual(res.json(), { error: 'Numéro de série différent de celui enrôlé', code: 'SERIAL_MISMATCH' })
  const { rows: [audit] } = await db.query("SELECT by_user, target, details FROM audit_logs WHERE action = 'linux_key_serial_mismatch' AND target = $1", [agent.device.id])
  assert.equal(audit.by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.equal(audit.details.expected, 'SN-CK-MM')
  const { rows: [device] } = await db.query('SELECT os FROM devices WHERE id = $1', [agent.device.id])
  assert.equal(device.os, null)
})

test('/checkin — 12 par heure et par poste : le 13e → 429 DEVICE_RATE_LIMIT ; un autre poste passe', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-CK-RATE')
  const other = await approvedAgent('SN-CK-RATE-2')
  const ip = nextIp()
  for (let i = 0; i < 12; i++) assert.equal((await checkin(app, agent, { ip })).statusCode, 200, `passage ${i + 1}`)
  const res = await checkin(app, agent, { ip })
  assert.equal(res.statusCode, 429, res.body)
  const body = res.json()
  assert.equal(body.code, 'DEVICE_RATE_LIMIT')
  assert.ok(body.retry_after_ms > 0 && body.retry_after_ms <= 3600_000)
  assert.equal(res.headers['retry-after'], String(Math.ceil(body.retry_after_ms / 1000)))
  assert.equal((await checkin(app, other, { ip })).statusCode, 200, 'limite par poste, pas par IP')
})
