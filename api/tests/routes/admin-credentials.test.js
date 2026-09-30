// routes/admin-credentials.js : POST /:deviceId/reveal (déchiffrement LAPS,
// motif requis, session interactive, audit fail-closed) + POST
// /:device_id/rotate (flag rotation).
//
// L'endpoint reveal appelle crypto.privateDecrypt avec une vraie clé RSA-OAEP.
// On génère une paire RSA de test en before(), on écrit la clé privée dans un
// fichier temporaire (t.TempDir-like via os.tmpdir), et on pointe
// LAPS_PRIVATE_KEY dessus. Le ciphertext inséré en DB est chiffré avec la clé
// publique correspondante. Pas de mock de la DB — acquireSchema() fournit un
// schéma Postgres isolé (le trigger du test fail-closed y reste confiné).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { insertAdminCredential } from '../fixtures/admin-credentials.js'

import adminCredentialsRoute from '../../modules/inventory/routes/admin-credentials.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const REASON = { category: 'incident', note: 'Utilisateur bloqué au démarrage, ticket #412' }

let schema, db, release, fastify, jwt
let tmpKeyPath, rsaPublicKey
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return

  prevEnv = {
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
    LAPS_PRIVATE_KEY: process.env.LAPS_PRIVATE_KEY,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  // Génère une paire RSA 2048 pour les tests LAPS.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  rsaPublicKey = publicKey

  // Écrit la clé privée dans un fichier temporaire.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-test-'))
  tmpKeyPath = path.join(tmpDir, 'laps.key')
  await fs.writeFile(tmpKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.LAPS_PRIVATE_KEY = tmpKeyPath

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(adminCredentialsRoute, { prefix: '/api/admin-credentials' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  // Nettoie le fichier de clé temporaire.
  if (tmpKeyPath) await fs.rm(path.dirname(tmpKeyPath), { recursive: true, force: true }).catch(() => {})
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminAuth(entraId = 'oid-laps-admin', email = 'laps-admin@test.local') {
  const u = await seedAdmin(db, { entraId, email, displayName: 'LAPS Admin' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  return { user: u, token }
}

// Token CLI (opl_…) d'un admin : requireAdmin passe, requireInteractive refuse.
async function cliTokenFor(entraId) {
  const secret = crypto.randomBytes(32).toString('hex')
  await db.query('INSERT INTO cli_tokens (entra_id, label, token_hash) VALUES ($1, $2, $3)',
    [entraId, 'test', crypto.createHash('sha256').update(secret).digest('hex')])
  return 'opl_' + secret
}

// Chiffre une chaîne avec la clé RSA publique de test (même algo que l'agent).
function encryptForTest(plaintext) {
  return crypto.publicEncrypt(
    { key: rsaPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plaintext, 'utf8')
  )
}

const reveal = (deviceId, token, payload = { reason: REASON }) => fastify.inject({
  method: 'POST', url: `/api/admin-credentials/${deviceId}/reveal`,
  headers: token ? { authorization: `Bearer ${token}` } : {}, payload,
})

const viewed = async deviceId => (await db.query(
  'SELECT last_viewed_at, last_viewed_by FROM device_admin_credentials WHERE device_id = $1', [deviceId],
)).rows[0]

const audits = async deviceId => (await db.query(
  "SELECT by_user, details FROM audit_logs WHERE action = 'laps_viewed' AND target = $1 ORDER BY created_at", [deviceId],
)).rows

// ─── POST /:deviceId/reveal — happy path admin ──────────────────────────────

test('POST /:deviceId/reveal — admin happy path : mot de passe déchiffré, audit laps_viewed avec le motif, last_viewed_* posés', { skip: SKIP }, async () => {
  const { user, token } = await adminAuth('oid-laps-get-ok', 'laps-get-ok@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-GET' })
  const plainPassword = 'S3cr3tP@ssw0rd!'
  const ciphertext = encryptForTest(plainPassword)
  await insertAdminCredential(db, { device_id: device.id, username: 'opale-recovery', encrypted_password: ciphertext })

  const res = await reveal(device.id, token)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.username, 'opale-recovery')
  assert.equal(body.password, plainPassword)
  assert.ok(body.password_changed_at)
  assert.equal(body.device_id, undefined, 'réponse limitée au contrat de la spec')

  // Audit log laps_viewed inséré, avec le motif et l'issue.
  const rows = await audits(device.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].by_user, user.email)
  assert.deepEqual(rows[0].details, { hostname: 'PC-LAPS-GET', username: 'opale-recovery', reason: REASON, outcome: 'ok' })
  const v = await viewed(device.id)
  assert.ok(v.last_viewed_at)
  assert.equal(v.last_viewed_by, user.entraId)
})

// ─── POST /:deviceId/reveal — gardes ────────────────────────────────────────

test('POST /:deviceId/reveal — non-admin → 403, sans Bearer → 401, token CLI → 403 INTERACTIVE_ONLY (reveal et rotate)', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-laps-get-na', email: 'laps-na@test.local' })
  const nonAdmin = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const { user } = await adminAuth('oid-laps-cli', 'laps-cli@test.local')
  const cli = await cliTokenFor(user.entraId)
  const device = await seedDevice(db, { hostname: 'PC-LAPS-NA' })
  await insertAdminCredential(db, { device_id: device.id, encrypted_password: encryptForTest('x') })

  assert.equal((await reveal(device.id, nonAdmin)).statusCode, 403)
  assert.equal((await reveal(device.id, null)).statusCode, 401)
  const res = await reveal(device.id, cli)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'INTERACTIVE_ONLY')
  const rotate = await fastify.inject({ method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`, headers: { authorization: `Bearer ${cli}` } })
  assert.equal(rotate.statusCode, 403)
  assert.equal(rotate.json().code, 'INTERACTIVE_ONLY')
  // Rien n'a été révélé ni tracé.
  assert.equal((await audits(device.id)).length, 0)
  assert.equal((await viewed(device.id)).last_viewed_at, null)
})

test('POST /:deviceId/reveal — sans motif, note trop courte ou catégorie inconnue → 400 ; l’ancien GET n’existe plus', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-400', 'laps-400@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-400' })
  await insertAdminCredential(db, { device_id: device.id, encrypted_password: encryptForTest('x') })

  for (const payload of [{}, { reason: { category: 'incident', note: 'trop' } }, { reason: { category: 'curiosite', note: 'assez long comme note' } }]) {
    const res = await reveal(device.id, token, payload)
    assert.equal(res.statusCode, 400, res.body)
  }
  assert.equal((await audits(device.id)).length, 0)
  const legacy = await fastify.inject({ method: 'GET', url: `/api/admin-credentials/${device.id}`, headers: { authorization: `Bearer ${token}` } })
  assert.equal(legacy.statusCode, 404)
})

test('POST /:deviceId/reveal — device sans credential → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-get-404', 'laps-404@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-NO-CRED' })
  // Pas d'insertAdminCredential ici.
  assert.equal((await reveal(device.id, token)).statusCode, 404)
})

test('POST /:deviceId/reveal — chiffré indéchiffrable → 500 DECRYPT_FAILED audité « failed », last_viewed_* intacts', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-decrypt', 'laps-decrypt@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-BAD' })
  await insertAdminCredential(db, { device_id: device.id })  // ciphertext factice du fixture

  const res = await reveal(device.id, token)
  assert.equal(res.statusCode, 500, res.body)
  assert.equal(res.json().code, 'DECRYPT_FAILED')
  assert.equal(res.json().password, undefined)
  const rows = await audits(device.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].details.outcome, 'failed')
  assert.deepEqual(rows[0].details.reason, REASON)
  assert.equal((await viewed(device.id)).last_viewed_at, null)
})

// Fail-closed : un trigger BEFORE INSERT sur audit_logs (dans le schéma de la
// suite) fait échouer la trace ; la transaction est annulée et le mot de passe
// ne part pas.
test('POST /:deviceId/reveal — trace d’audit impossible → 500 sans mot de passe, last_viewed_* inchangés (fail-closed)', { skip: SKIP }, async (t) => {
  const { token } = await adminAuth('oid-laps-closed', 'laps-closed@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-CLOSED' })
  await insertAdminCredential(db, { device_id: device.id, encrypted_password: encryptForTest('Secret!') })
  await db.query(`
    CREATE FUNCTION audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit refusé (test)'; END $$
  `)
  await db.query('CREATE TRIGGER audit_refuse BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_refuse()')
  t.after(async () => {
    await db.query('DROP TRIGGER audit_refuse ON audit_logs')
    await db.query('DROP FUNCTION audit_refuse()')
  })

  const res = await reveal(device.id, token)
  assert.equal(res.statusCode, 500, res.body)
  assert.equal(res.json().code, 'AUDIT_FAILED')
  assert.ok(!res.body.includes('Secret!'), 'le mot de passe ne doit pas partir')
  assert.equal(res.json().password, undefined)
  assert.equal((await viewed(device.id)).last_viewed_at, null)
  assert.equal((await audits(device.id)).length, 0)
})

// ─── POST /:device_id/rotate — happy path admin ─────────────────────────────

test('POST /:device_id/rotate — admin happy path : flag rotation + audit laps_rotation_requested', { skip: SKIP }, async () => {
  const { user, token } = await adminAuth('oid-laps-rot-ok', 'laps-rot-ok@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-ROTATE' })
  await insertAdminCredential(db, { device_id: device.id, rotation_requested_at: null })

  const res = await fastify.inject({
    method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 202)
  assert.equal(res.json().status, 'queued')

  // rotation_requested_at doit être posé.
  const { rows } = await db.query(
    `SELECT rotation_requested_at FROM device_admin_credentials WHERE device_id = $1`,
    [device.id]
  )
  assert.ok(rows[0].rotation_requested_at, 'rotation_requested_at doit être set')

  // Audit log laps_rotation_requested inséré.
  const { rows: audits } = await db.query(
    `SELECT action, by_user, target FROM audit_logs
     WHERE action = 'laps_rotation_requested' AND target = $1`,
    [device.id]
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0].by_user, user.email)
  assert.equal(audits[0].target, device.id)
})

// ─── POST /:device_id/rotate — device sans credential → 404 ────────────────

test('POST /:device_id/rotate — device sans credential → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-rot-404', 'laps-rot-404@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-ROT-NOCRED' })
  // Pas d'insertAdminCredential.

  const res = await fastify.inject({
    method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── POST /:device_id/rotate — idempotence ──────────────────────────────────

test('POST /:device_id/rotate — idempotence : 2 appels consécutifs → 202 les deux, rotation_requested_at mis à jour', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-rot-idem', 'laps-rot-idem@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-IDEM' })
  await insertAdminCredential(db, { device_id: device.id })

  const res1 = await fastify.inject({
    method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res1.statusCode, 202)

  const { rows: before } = await db.query(
    `SELECT rotation_requested_at FROM device_admin_credentials WHERE device_id = $1`,
    [device.id]
  )
  const firstTs = before[0].rotation_requested_at

  // Petit délai pour que now() diffère (Postgres résolution < ms en général).
  await new Promise(r => setTimeout(r, 10))

  const res2 = await fastify.inject({
    method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res2.statusCode, 202)

  const { rows: after } = await db.query(
    `SELECT rotation_requested_at FROM device_admin_credentials WHERE device_id = $1`,
    [device.id]
  )
  // Le timestamp doit avoir été mis à jour (UPDATE SET rotation_requested_at = now()).
  assert.ok(
    new Date(after[0].rotation_requested_at) >= new Date(firstTs),
    'rotation_requested_at doit être >= au premier appel'
  )

  // Chaque appel produit un audit log → 2 au total.
  const { rows: audits } = await db.query(
    `SELECT action FROM audit_logs
     WHERE action = 'laps_rotation_requested' AND target = $1`,
    [device.id]
  )
  assert.equal(audits.length, 2, '2 appels = 2 lignes audit')
})

// ─── POST /:device_id/rotate — non-admin → 403 ──────────────────────────────

test('POST /:device_id/rotate — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-laps-rot-na', email: 'laps-rot-na@test.local' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const device = await seedDevice(db, { hostname: 'PC-LAPS-ROT-NA' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/admin-credentials/${device.id}/rotate`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})
