// GET /api/linux/devices/:id/recovery-keys et POST …/:kid/reveal (docs/
// linux-fleet-design.md §5) : métadonnées courantes d'abord, gardes (admin,
// session interactive, motif), 404 hors poste, révélation « fail-closed » :
// audit avec motif + last_viewed_* validés avant l'envoi, échec de
// déchiffrement audité, et trace impossible (trigger sur audit_logs) → aucun
// secret ne part. Clé LAPS temporaire, miroir simulé, base réelle.

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
const NIL = '00000000-0000-4000-8000-000000000000'
const SHA = c => c.repeat(40)
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }
const REASON = { category: 'incident', note: 'Utilisateur bloqué au démarrage, ticket #412' }
const SECRET = 'luks-recovery-0123-4567-89ab'

let db, release, app, jwt, admin, user, cli, tmpDir, validateMeta, validateSecret
const prevKeyPath = process.env.LAPS_PRIVATE_KEY
const gitMirror = {
  serving: () => true, status: () => ({ state: 'ready' }),
  heads: () => ({ pilot: SHA('a'), stable: SHA('b'), upstream: {} }),
  tipSince: () => new Date().toISOString(), listProfiles: async () => ['admin', 'field'],
}
const devices = {}, keys = {}

before(async () => {
  if (SKIP) return
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-rk-'))
  process.env.LAPS_PRIVATE_KEY = path.join(tmpDir, 'laps.key')
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  await fs.writeFile(process.env.LAPS_PRIVATE_KEY, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const encrypt = (plaintext, key = pair.publicKey) => crypto.publicEncrypt({ key, ...OAEP }, Buffer.from(plaintext))
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  app = await buildApp({ db, jwks: jwt.jwks, decorators: { gitMirror }, routes: f => f.register(devicesRoutes, { prefix: '/api/linux' }) })
  const a = await seedAdmin(db, { entraId: 'oid-rk-admin', displayName: 'Admin Rk', email: 'admin-rk@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  const u = await seedNonAdmin(db, { entraId: 'oid-rk-user', displayName: 'Marie Curie', email: 'm.curie@example.org' })
  user = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }
  const secret = crypto.randomBytes(32).toString('hex')
  await db.query('INSERT INTO cli_tokens (entra_id, label, token_hash) VALUES ($1, $2, $3)',
    [a.entraId, 'test', crypto.createHash('sha256').update(secret).digest('hex')])
  cli = { authorization: `Bearer opl_${secret}` }

  devices.lx = await seedDevice(db, { hostname: 'lx-rk', serial: 'SN-RK', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'pilot' })
  await seedLinuxDeviceKey(db, { deviceId: devices.lx.id, status: 'approved', serialClaimed: 'SN-RK' })
  devices.lx2 = await seedDevice(db, { hostname: 'lx-rk2', serial: 'SN-RK2', platform: 'linux', managed_by: 'pull', profile: 'admin', ring: 'pilot' })
  devices.win = await seedDevice(db, { hostname: 'PC-WIN', serial: 'SN-WIN' })
  const insert = async (deviceId, label, ciphertext, keyId, age, superseded = false) => (await db.query(`
    INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id, created_at, superseded_at)
    VALUES ($1, 'luks_recovery', $2, $3, $4, now() - $5::interval, CASE WHEN $6 THEN now() - interval '1 hour' END) RETURNING id
  `, [deviceId, label, ciphertext, keyId, age, superseded])).rows[0].id
  // Courante, ancienne supersédée, et une ligne chiffrée sous une autre clé (non courante, indéchiffrable).
  keys.current = await insert(devices.lx.id, '/', encrypt(SECRET), lapsKeyId(), '1 hour')
  keys.old     = await insert(devices.lx.id, '/', Buffer.from('\x00'), 'old-key', '1 day', true)
  keys.foreign = await insert(devices.lx.id, '/boot', encrypt('x', crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey), 'other-key', '2 hours')
  keys.lx2     = await insert(devices.lx2.id, '/', encrypt('other-device-secret'), lapsKeyId(), '1 hour')

  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validateMeta = ajv.compile(deref(loadSpec().components.schemas.RecoveryKeyMeta))
  validateSecret = ajv.compile(deref(loadSpec().components.schemas.RevealedSecret))
})

after(async () => {
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  if (prevKeyPath === undefined) delete process.env.LAPS_PRIVATE_KEY; else process.env.LAPS_PRIVATE_KEY = prevKeyPath
})

const api = (method, url, { headers = admin, payload } = {}) => app.inject({ method, url, headers, payload })
const list = (deviceId, headers) => api('GET', `/api/linux/devices/${deviceId}/recovery-keys`, { headers })
const reveal = (deviceId, kid, { headers, payload = { reason: REASON } } = {}) => api('POST', `/api/linux/devices/${deviceId}/recovery-keys/${kid}/reveal`, { headers, payload })
const viewed = async kid => (await db.query('SELECT last_viewed_at, last_viewed_by FROM device_recovery_keys WHERE id = $1', [kid])).rows[0]
const audits = async deviceId => (await db.query(
  "SELECT by_user, details FROM audit_logs WHERE action = 'linux_recovery_key_viewed' AND target = $1 ORDER BY created_at", [deviceId],
)).rows

test('gardes : sans Bearer 401, non-admin 403 ; token CLI : liste 200 mais révélation 403 INTERACTIVE_ONLY, rien n’est tracé', { skip: SKIP }, async () => {
  assert.equal((await list(devices.lx.id, {})).statusCode, 401)
  assert.equal((await reveal(devices.lx.id, keys.current, { headers: {} })).statusCode, 401)
  assert.equal((await list(devices.lx.id, user)).statusCode, 403)
  assert.equal((await reveal(devices.lx.id, keys.current, { headers: user })).statusCode, 403)
  assert.equal((await list(devices.lx.id, cli)).statusCode, 200)
  const res = await reveal(devices.lx.id, keys.current, { headers: cli })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'INTERACTIVE_ONLY')
  assert.equal((await audits(devices.lx.id)).length, 0)
  assert.equal((await viewed(keys.current)).last_viewed_at, null)
})

test('GET /devices/:id/recovery-keys — RecoveryKeyMeta, courante d’abord puis par date ; poste Windows ou inconnu → 404', { skip: SKIP }, async () => {
  const res = await list(devices.lx.id)
  assert.equal(res.statusCode, 200, res.body)
  const { rows } = res.json()
  for (const row of rows) assert.ok(validateMeta(row), JSON.stringify(validateMeta.errors))
  assert.deepEqual(rows.map(r => [r.id, r.current, r.superseded_at === null]), [[keys.current, true, true], [keys.foreign, false, true], [keys.old, false, false]])
  assert.deepEqual(rows.map(r => r.last_viewed_by_name), [null, null, null])
  assert.equal(res.body.includes('ciphertext'), false)
  assert.equal((await list(devices.win.id)).statusCode, 404)
  assert.equal((await list(NIL)).statusCode, 404)
  assert.equal((await list('pas-un-uuid')).statusCode, 400)
})

test('reveal — 400 sans motif, note courte ou catégorie inconnue ; 404 kid inconnu ou clé d’un autre poste ; rien n’est tracé', { skip: SKIP }, async () => {
  for (const payload of [{}, { reason: { category: 'incident', note: 'trop' } }, { reason: { category: 'curiosite', note: 'assez long comme note' } }]) {
    assert.equal((await reveal(devices.lx.id, keys.current, { payload })).statusCode, 400, JSON.stringify(payload))
  }
  assert.equal((await reveal(devices.lx.id, NIL)).statusCode, 404)
  assert.equal((await reveal(devices.lx.id, keys.lx2)).statusCode, 404, 'clé d’un autre poste')
  assert.equal((await reveal(devices.win.id, keys.current)).statusCode, 404)
  assert.equal((await audits(devices.lx.id)).length, 0)
  assert.equal((await viewed(keys.lx2)).last_viewed_at, null)
})

test('reveal — 200 RevealedSecret après COMMIT : audit linux_recovery_key_viewed avec le motif, last_viewed_* posés et visibles dans la liste', { skip: SKIP }, async () => {
  const res = await reveal(devices.lx.id, keys.current)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.ok(validateSecret(body), JSON.stringify(validateSecret.errors))
  assert.equal(body.secret, SECRET)
  assert.deepEqual([body.kind, body.label, body.key_id], ['luks_recovery', '/', lapsKeyId()])
  const rows = await audits(devices.lx.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].by_user, 'Admin Rk')
  assert.deepEqual(rows[0].details, { label: '/', key_id: lapsKeyId(), reason: REASON, outcome: 'ok' })
  const v = await viewed(keys.current)
  assert.ok(v.last_viewed_at)
  assert.equal(v.last_viewed_by, 'oid-rk-admin')
  const [meta] = (await list(devices.lx.id)).json().rows
  assert.equal(meta.id, keys.current)
  assert.equal(meta.last_viewed_by_name, 'Admin Rk')
  assert.ok(meta.last_viewed_at)
})

test('reveal — chiffré sous une autre clé → 500 DECRYPT_FAILED audité « failed », last_viewed_* intacts, aucun secret', { skip: SKIP }, async () => {
  const res = await reveal(devices.lx.id, keys.foreign)
  assert.equal(res.statusCode, 500, res.body)
  assert.equal(res.json().code, 'DECRYPT_FAILED')
  assert.equal(res.json().secret, undefined)
  const rows = await audits(devices.lx.id)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1].details, { label: '/boot', key_id: 'other-key', reason: REASON, outcome: 'failed' })
  assert.equal((await viewed(keys.foreign)).last_viewed_at, null)
})

// Fail-closed : un trigger BEFORE INSERT sur audit_logs (dans le schéma de la
// suite) fait échouer la trace ; la transaction est annulée et le secret ne
// part pas.
test('reveal — trace d’audit impossible → 500 AUDIT_FAILED sans secret, last_viewed_* inchangés (fail-closed)', { skip: SKIP }, async (t) => {
  await db.query(`
    CREATE FUNCTION audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit refusé (test)'; END $$
  `)
  await db.query('CREATE TRIGGER audit_refuse BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_refuse()')
  t.after(async () => {
    await db.query('DROP TRIGGER audit_refuse ON audit_logs')
    await db.query('DROP FUNCTION audit_refuse()')
  })
  const res = await reveal(devices.lx2.id, keys.lx2)
  assert.equal(res.statusCode, 500, res.body)
  assert.equal(res.json().code, 'AUDIT_FAILED')
  assert.equal(res.json().secret, undefined)
  assert.ok(!res.body.includes('other-device-secret'), 'le secret ne doit pas partir')
  assert.equal((await viewed(keys.lx2)).last_viewed_at, null)
  assert.equal((await audits(devices.lx2.id)).length, 0)
})
