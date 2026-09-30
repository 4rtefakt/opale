// POST /api/linux/agent/escrow (docs/linux-fleet-design.md §4, décision §9.3),
// GET /escrow/status et POST /escrow/confirm-backup (§5) : refus communs,
// escrow du compte local (upsert, garde anti-rejeu, compte configuré), escrow
// LUKS derrière la porte de sauvegarde (supersession par label), audits sans
// chiffré, limite par poste, et l'état d'escrow vu par le check-in avant et
// après confirmation. Clé LAPS temporaire, miroir simulé, base réelle.

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
import { signedPost, checkin } from '../helpers/linux-agent.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { insertAdminCredential } from '../fixtures/admin-credentials.js'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'
import { loadSpec, deref } from '../../modules/linux/lib/spec.js'
import { lapsKeyId, loadLAPSKey } from '../../modules/inventory/lib/laps-key.js'
import { ROTATED_AT_MAX_SKEW_MS } from '../../modules/linux/lib/escrow.js'
import agentRoutes from '../../modules/linux/routes/agent.js'
import escrowRoutes from '../../modules/linux/routes/escrow.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }

let db, release, app, jwt, admin, user, cli, tokenStore, tmpDir, keyPath, publicKey, validateAck, validateStatus
const prevEnv = { FRONTEND_URL: process.env.FRONTEND_URL, LAPS_PRIVATE_KEY: process.env.LAPS_PRIVATE_KEY }
const gitMirror = { serving: () => true, heads: () => ({ pilot: SHA('a'), stable: SHA('b'), upstream: {} }) }

before(async () => {
  if (SKIP) return
  process.env.FRONTEND_URL = 'https://opale.test'
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-escrow-'))
  keyPath = path.join(tmpDir, 'laps.key')
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKey = pair.publicKey
  await fs.writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  // La clé n'est pointée qu'après le premier test (escrow indisponible).
  process.env.LAPS_PRIVATE_KEY = path.join(tmpDir, 'absente.key')
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  tokenStore = createGitTokenStore()
  app = await buildApp({
    db, jwks: jwt.jwks, decorators: { gitMirror, gitTokenStore: tokenStore },
    routes: async f => {
      await f.register(agentRoutes,  { prefix: '/api/linux/agent' })
      await f.register(escrowRoutes, { prefix: '/api/linux' })
    },
  })
  const a = await seedAdmin(db, { entraId: 'oid-esc-admin', displayName: 'Admin Esc', email: 'admin-esc@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  const u = await seedNonAdmin(db, { entraId: 'oid-esc-user', displayName: 'Marie Curie', email: 'm.curie@example.org' })
  user = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }
  // Token CLI d'un admin : requireAdmin passe, requireInteractive refuse.
  const secret = crypto.randomBytes(32).toString('hex')
  await db.query('INSERT INTO cli_tokens (entra_id, label, token_hash) VALUES ($1, $2, $3)',
    [a.entraId, 'test', crypto.createHash('sha256').update(secret).digest('hex')])
  cli = { authorization: `Bearer opl_${secret}` }
  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validateAck = ajv.compile(deref(loadSpec().components.schemas.EscrowAck))
  validateStatus = ajv.compile(deref(loadSpec().components.schemas.EscrowStatus))
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
const b64 = size => Buffer.alloc(size, 7).toString('base64')
const encrypt = plaintext => crypto.publicEncrypt({ key: publicKey, ...OAEP }, Buffer.from(plaintext)).toString('base64')
const decrypt = buffer => crypto.privateDecrypt({ key: loadLAPSKey(), ...OAEP }, buffer).toString('utf8')
const api = (method, url, { headers = admin, payload } = {}) => app.inject({ method, url, headers, payload })
const escrow = (agent, body, ip = nextIp()) => signedPost(app, agent, '/api/linux/agent/escrow', { payload: body, ip })
const luks = (label = '/', secret = 'luks-recovery-0123-4567') => ({ kind: 'luks_recovery', label, ciphertext: encrypt(secret), escrow_key_id: lapsKeyId() })
const localAdmin = (rotatedAt, secret = 'Pw1!', username = 'opale-recovery') =>
  ({ kind: 'local_admin', username, ciphertext: encrypt(secret), rotated_at: new Date(rotatedAt).toISOString(), escrow_key_id: lapsKeyId() })

// Poste pull approuvé et son agent signataire (même forme que newAgent()).
async function approvedAgent(serial, device = {}) {
  const row = await seedDevice(db, { hostname: `lx-${serial.toLowerCase()}`, serial, platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot', ...device })
  const key = await seedLinuxDeviceKey(db, { deviceId: row.id, status: 'approved', serialClaimed: serial })
  return {
    device: row, key, privateKey: key.privateKey, fingerprint: key.fingerprint,
    body: { serial, hostname: 'claimed-by-agent', os_version: 'Debian GNU/Linux 12 (bookworm)', agent_version: '0.2.0' },
  }
}

const recoveryRows = async deviceId => (await db.query(
  'SELECT id, label, key_id, ciphertext, superseded_at FROM device_recovery_keys WHERE device_id = $1 ORDER BY created_at, id', [deviceId],
)).rows
const auditRows = async (action, target) => (await db.query(
  'SELECT by_user, details FROM audit_logs WHERE action = $1 AND ($2::uuid IS NULL OR target = $2::text) ORDER BY created_at', [action, target ?? null],
)).rows
const backupSetting = async () => (await db.query("SELECT value FROM settings WHERE key = 'linux.escrow_backup_confirmed'")).rows[0].value

test('/escrow — clé LAPS illisible → 503 ESCROW_UNAVAILABLE avant tout autre contrôle', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-NOKEY')
  const res = await escrow(agent, { kind: 'luks_recovery', label: '/', ciphertext: b64(256), escrow_key_id: 'f'.repeat(64) })
  assert.equal(res.statusCode, 503, res.body)
  assert.equal(res.json().code, 'ESCROW_UNAVAILABLE')
  process.env.LAPS_PRIVATE_KEY = keyPath
})

test('/escrow — sans signature 401, clé pending 401, corps hors schéma 400, autre clé 409 ESCROW_KEY_MISMATCH, chiffré trop court 400 CIPHERTEXT_SIZE', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-REFUS')
  const bare = await app.inject({ method: 'POST', url: '/api/linux/agent/escrow', remoteAddress: nextIp(), payload: luks() })
  assert.equal(bare.statusCode, 401)
  const pending = await seedLinuxDeviceKey(db, { status: 'pending', serialClaimed: 'SN-ES-PENDING' })
  assert.equal((await escrow({ ...pending, body: {} }, luks())).statusCode, 401)
  for (const body of [{ ...luks(), kind: 'tpm_owner' }, { ...localAdmin(Date.now()), rotated_at: undefined }, { ...luks(), label: 'a b' }]) {
    assert.equal((await escrow(agent, body)).statusCode, 400, JSON.stringify(body))
  }
  const mismatch = await escrow(agent, { ...luks(), escrow_key_id: 'e'.repeat(64) })
  assert.equal(mismatch.statusCode, 409, mismatch.body)
  assert.equal(mismatch.json().code, 'ESCROW_KEY_MISMATCH')
  const short = await escrow(agent, { ...luks(), ciphertext: b64(100) })
  assert.equal(short.statusCode, 400, short.body)
  assert.equal(short.json().code, 'CIPHERTEXT_SIZE')
  assert.equal((await recoveryRows(agent.device.id)).length, 0)
})

test('/escrow local_admin — upsert (password_changed_at = rotated_at, rotation effacée), audit laps_rotated par device:<fp12>, rejeu plus ancien → 409 ESCROW_STALE, rotated_at futur → 400 ROTATED_AT_IN_FUTURE, compte différent → 400 USERNAME_MISMATCH', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-LA')
  await insertAdminCredential(db, { device_id: agent.device.id })
  await db.query("UPDATE device_admin_credentials SET password_changed_at = now() - interval '1 hour', rotation_requested_at = now() WHERE device_id = $1", [agent.device.id])
  const rotatedAt = Date.now()
  const res = await escrow(agent, localAdmin(rotatedAt))
  assert.equal(res.statusCode, 201, res.body)
  const ack = res.json()
  assert.ok(validateAck(ack), JSON.stringify(validateAck.errors))
  assert.equal(ack.kind, 'local_admin')
  assert.equal(ack.key_id, lapsKeyId())
  assert.equal(Date.parse(ack.stored_at), rotatedAt)
  const { rows: [row] } = await db.query('SELECT * FROM device_admin_credentials WHERE device_id = $1', [agent.device.id])
  assert.equal(decrypt(row.encrypted_password), 'Pw1!')
  assert.equal(row.username, 'opale-recovery')
  assert.equal(row.password_changed_at.getTime(), rotatedAt)
  assert.equal(row.rotation_requested_at, null)
  const [audit] = await auditRows('laps_rotated', agent.device.id)
  assert.equal(audit.by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.deepEqual(audit.details, { username: 'opale-recovery' })

  const stale = await escrow(agent, localAdmin(rotatedAt - 60_000, 'Old!'))
  assert.equal(stale.statusCode, 409, stale.body)
  assert.equal(stale.json().code, 'ESCROW_STALE')
  const { rows: [same] } = await db.query('SELECT encrypted_password FROM device_admin_credentials WHERE device_id = $1', [agent.device.id])
  assert.equal(decrypt(same.encrypted_password), 'Pw1!', 'ligne intacte')
  assert.equal((await auditRows('laps_rotated', agent.device.id)).length, 1)

  // Horloge fausse : une date future stockée rendrait toute rotation sincère
  // ESCROW_STALE ; refusée avant l'upsert (6 appels par minute et par poste
  // dans ce test, la tolérance elle-même est couverte par rotatedAt = now).
  const future = await escrow(agent, localAdmin(Date.now() + ROTATED_AT_MAX_SKEW_MS + 60_000, 'Fut!'))
  assert.equal(future.statusCode, 400, future.body)
  assert.equal(future.json().code, 'ROTATED_AT_IN_FUTURE')
  const { rows: [untouched] } = await db.query('SELECT password_changed_at FROM device_admin_credentials WHERE device_id = $1', [agent.device.id])
  assert.equal(untouched.password_changed_at.getTime(), rotatedAt, 'ligne intacte')

  const other = await escrow(agent, localAdmin(rotatedAt + 1000, 'Pw2!', 'root'))
  assert.equal(other.statusCode, 400, other.body)
  assert.equal(other.json().code, 'USERNAME_MISMATCH')
  // Compte configuré : même réglage que l'agent Windows.
  await db.query("INSERT INTO settings (key, value) VALUES ('agent.laps_recovery_username', 'it-recovery') ON CONFLICT (key) DO UPDATE SET value = 'it-recovery'")
  try {
    assert.equal((await escrow(agent, localAdmin(rotatedAt + 1000, 'Pw2!'))).json().code, 'USERNAME_MISMATCH')
    assert.equal((await escrow(agent, localAdmin(rotatedAt + 1000, 'Pw2!', 'it-recovery'))).statusCode, 201)
  } finally {
    await db.query("DELETE FROM settings WHERE key = 'agent.laps_recovery_username'")
  }
})

test('/escrow luks_recovery — porte de sauvegarde : 409 ESCROW_BACKUP_UNCONFIRMED et check-in backup_unconfirmed ; confirm-backup (réglage, audit) ; puis 201, check-in ok sans luks_recovery à escrower', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-LUKS')
  assert.equal(await backupSetting(), '', 'réglage vide par défaut (migration 080)')
  const before = await checkin(app, agent, { ip: nextIp(), body: { luks_root: true } })
  assert.equal(before.statusCode, 200, before.body)
  assert.equal(before.json().escrow.status, 'backup_unconfirmed')
  assert.ok(before.json().escrow_needed.includes('luks_recovery'))
  const refused = await escrow(agent, luks())
  assert.equal(refused.statusCode, 409, refused.body)
  assert.equal(refused.json().code, 'ESCROW_BACKUP_UNCONFIRMED')
  assert.equal((await recoveryRows(agent.device.id)).length, 0)
  assert.equal((await api('GET', '/api/linux/escrow/status')).json().backup_confirmed, null)

  const confirmed = await api('POST', '/api/linux/escrow/confirm-backup', { payload: { key_id: lapsKeyId(), confirmed: true } })
  assert.equal(confirmed.statusCode, 200, confirmed.body)
  const status = confirmed.json()
  assert.ok(validateStatus(status), JSON.stringify(validateStatus.errors))
  assert.equal(status.status, 'ok')
  assert.equal(status.backup_confirmed.key_id, lapsKeyId())
  assert.equal(status.backup_confirmed.by, 'Admin Esc')
  assert.ok(Date.now() - Date.parse(status.backup_confirmed.at) < 10_000)
  assert.equal(typeof status.devices_needing_escrow, 'number')
  assert.deepEqual(JSON.parse(await backupSetting()), status.backup_confirmed)
  const [audit] = await auditRows('linux_escrow_backup_confirmed')
  assert.equal(audit.by_user, 'Admin Esc')
  assert.deepEqual(audit.details, { key_id: lapsKeyId() })

  const res = await escrow(agent, luks('/', 'luks-secret-0001'))
  assert.equal(res.statusCode, 201, res.body)
  const ack = res.json()
  assert.ok(validateAck(ack), JSON.stringify(validateAck.errors))
  assert.equal(ack.kind, 'luks_recovery')
  const [row] = await recoveryRows(agent.device.id)
  assert.equal(row.id, ack.id)
  assert.equal(row.key_id, lapsKeyId())
  assert.equal(row.superseded_at, null)
  assert.equal(decrypt(row.ciphertext), 'luks-secret-0001')
  const [escrowed] = await auditRows('linux_recovery_key_escrowed', agent.device.id)
  assert.equal(escrowed.by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.deepEqual(escrowed.details, { label: '/', key_id: lapsKeyId() }, 'jamais le chiffré')

  const after = await checkin(app, agent, { ip: nextIp(), body: { luks_root: true } })
  assert.equal(after.json().escrow.status, 'ok')
  assert.ok(!after.json().escrow_needed.includes('luks_recovery'))
})

test('/escrow luks_recovery — une nouvelle clé de même label supersède la précédente, un autre label reste courant', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-SUP')
  const first = (await escrow(agent, luks('/', 'first-000000000'))).json().id
  const slot = (await escrow(agent, luks('nvme0n1p3:slot1', 'slot-000000000'))).json().id
  const second = await escrow(agent, luks('/', 'second-00000000'))
  assert.equal(second.statusCode, 201, second.body)
  const rows = await recoveryRows(agent.device.id)
  assert.deepEqual(rows.map(r => [r.id, r.label, r.superseded_at !== null]), [[first, '/', true], [slot, 'nvme0n1p3:slot1', false], [second.json().id, '/', false]])
  assert.equal(decrypt(rows[0].ciphertext), 'first-000000000', 'historique conservé')
})

test('confirm-backup — sans Bearer 401, non-admin 403, token CLI 403 INTERACTIVE_ONLY, clé différente 409 KEY_ID_MISMATCH, confirmed:false 400 ; réglage intact ; /escrow/status lisible avec un token CLI', { skip: SKIP }, async () => {
  const value = await backupSetting()
  const payload = { key_id: lapsKeyId(), confirmed: true }
  assert.equal((await api('POST', '/api/linux/escrow/confirm-backup', { headers: {}, payload })).statusCode, 401)
  assert.equal((await api('POST', '/api/linux/escrow/confirm-backup', { headers: user, payload })).statusCode, 403)
  const interactive = await api('POST', '/api/linux/escrow/confirm-backup', { headers: cli, payload })
  assert.equal(interactive.statusCode, 403)
  assert.equal(interactive.json().code, 'INTERACTIVE_ONLY')
  const mismatch = await api('POST', '/api/linux/escrow/confirm-backup', { payload: { ...payload, key_id: 'e'.repeat(64) } })
  assert.equal(mismatch.statusCode, 409, mismatch.body)
  assert.equal(mismatch.json().code, 'KEY_ID_MISMATCH')
  assert.equal((await api('POST', '/api/linux/escrow/confirm-backup', { payload: { ...payload, confirmed: false } })).statusCode, 400)
  assert.equal(await backupSetting(), value)
  assert.equal((await auditRows('linux_escrow_backup_confirmed')).length, 1)
  assert.equal((await api('GET', '/api/linux/escrow/status', { headers: cli })).statusCode, 200)
})

test('/escrow — 6 par minute et par poste : le 7e → 429 DEVICE_RATE_LIMIT ; un autre poste passe', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-ES-RATE')
  const other = await approvedAgent('SN-ES-RATE-2')
  const ip = nextIp()
  const base = Date.now()
  for (let i = 0; i < 6; i++) assert.equal((await escrow(agent, localAdmin(base + i * 1000), ip)).statusCode, 201, `passage ${i + 1}`)
  const res = await escrow(agent, localAdmin(base + 7000), ip)
  assert.equal(res.statusCode, 429, res.body)
  const body = res.json()
  assert.equal(body.code, 'DEVICE_RATE_LIMIT')
  assert.ok(body.retry_after_ms > 0 && body.retry_after_ms <= 60_000)
  assert.equal(res.headers['retry-after'], String(Math.ceil(body.retry_after_ms / 1000)))
  assert.equal((await escrow(other, localAdmin(base), ip)).statusCode, 201, 'limite par poste, pas par IP')
})
