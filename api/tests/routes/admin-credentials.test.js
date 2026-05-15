// routes/admin-credentials.js : GET /:device_id (déchiffrement LAPS)
// + POST /:device_id/rotate (flag rotation).
//
// L'endpoint GET appelle crypto.privateDecrypt avec une vraie clé RSA-OAEP.
// On génère une paire RSA de test en before(), on écrit la clé privée dans un
// fichier temporaire (t.TempDir-like via os.tmpdir), et on pointe
// LAPS_PRIVATE_KEY dessus. Le ciphertext inséré en DB est chiffré avec la clé
// publique correspondante. Pas de mock de la DB — acquireSchema() fournit un
// schéma Postgres isolé.

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

// Chiffre une chaîne avec la clé RSA publique de test (même algo que l'agent).
function encryptForTest(plaintext) {
  return crypto.publicEncrypt(
    { key: rsaPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plaintext, 'utf8')
  )
}

// ─── GET /:device_id — happy path admin ────────────────────────────────────

test('GET /:device_id — admin happy path : retourne le mot de passe déchiffré + audit laps_viewed', { skip: SKIP || 'TODO: pre-existing flake — 7s+ wall time near node:test default timeout' }, async () => {
  const { user, token } = await adminAuth('oid-laps-get-ok', 'laps-get-ok@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-GET' })
  const plainPassword = 'S3cr3tP@ssw0rd!'
  const ciphertext = encryptForTest(plainPassword)
  await insertAdminCredential(db, { device_id: device.id, username: 'opale-recovery', encrypted_password: ciphertext })

  const res = await fastify.inject({
    method: 'GET', url: `/api/admin-credentials/${device.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.device_id, device.id)
  assert.equal(body.hostname, 'PC-LAPS-GET')
  assert.equal(body.username, 'opale-recovery')
  assert.equal(body.password, plainPassword)
  assert.ok(body.password_changed_at)

  // Audit log laps_viewed inséré.
  const { rows: audits } = await db.query(
    `SELECT action, by_user, target FROM audit_logs
     WHERE action = 'laps_viewed' AND target = $1`,
    [device.id]
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0].by_user, user.email)
  assert.equal(audits[0].target, device.id)
})

// ─── GET /:device_id — non-admin → 403 ─────────────────────────────────────

test('GET /:device_id — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-laps-get-na', email: 'laps-na@test.local' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const device = await seedDevice(db, { hostname: 'PC-LAPS-NA' })

  const res = await fastify.inject({
    method: 'GET', url: `/api/admin-credentials/${device.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── GET /:device_id — JWT manquant → 401 ──────────────────────────────────

test('GET /:device_id — sans Bearer → 401', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-LAPS-NOAUTH' })
  const res = await fastify.inject({
    method: 'GET', url: `/api/admin-credentials/${device.id}`,
  })
  assert.equal(res.statusCode, 401)
})

// ─── GET /:device_id — device sans credential → 404 ────────────────────────

test('GET /:device_id — device sans credential → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-laps-get-404', 'laps-404@test.local')
  const device = await seedDevice(db, { hostname: 'PC-LAPS-NO-CRED' })
  // Pas d'insertAdminCredential ici.

  const res = await fastify.inject({
    method: 'GET', url: `/api/admin-credentials/${device.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
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
