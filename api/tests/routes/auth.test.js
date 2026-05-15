// routes/auth.js : POST /api/auth/cli-token + GET /api/auth/config.
//
// Couverture sécu critique :
//   - JWT admin requis (requireAdmin) — un user normal ne peut pas générer
//     un token CLI (ce serait une escalation de privilège).
//   - Validation du label (présence, longueur, trim).
//   - Token retourné en clair UNE SEULE FOIS et préfixé `opl_`. Le hash
//     stocké en DB ne contient pas le préfixe (compat legacy hex64).
//   - Audit log enrichi avec token_id + expires_at.
//   - TTL 90 j appliqué côté DB.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import authRoute from '../../modules/core/routes/auth.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip routes/auth suite'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = {
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(authRoute, { prefix: '/api/auth' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ─── GET /api/auth/config ────────────────────────────────────────────────────

test('GET /config — retourne client_id + tenant_id depuis env, pas d\'auth requise', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/auth/config' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.client_id, 'test-client')
  assert.equal(body.tenant_id, 'test-tenant')
})

// ─── POST /api/auth/cli-token ────────────────────────────────────────────────

test('POST /cli-token — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    payload: { label: 'CLI' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /cli-token — JWT non-admin → 403 (pas d\'escalation)', { skip: SKIP }, async () => {
  // Critique sécu : si un user normal pouvait générer un token CLI, le hash
  // serait stocké avec son entra_id et il aurait un token longue durée
  // contournant ses propres permissions. requireAdmin doit bloquer en amont.
  await seedNonAdmin(db, { entraId: 'oid-tested-nonadmin' })
  const token = await jwt.sign({
    oid: 'oid-tested-nonadmin', name: 'Bob', preferred_username: 'bob@x',
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'tentative' },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /cli-token — admin sans label → utilise "CLI" par défaut', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-token-default-label' })
  const token = await jwt.sign({
    oid: admin.entraId, name: admin.displayName, preferred_username: admin.email,
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.label, 'CLI', 'label par défaut "CLI" appliqué')
  assert.match(body.token, /^opl_[0-9a-f]{64}$/, 'token préfixé opl_ + 64 hex')
})

test('POST /cli-token — label vide (whitespace) → 400', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-empty-label' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: '   ' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /label/i)
})

test('POST /cli-token — label > 100 chars → 400', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-long-label' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'a'.repeat(101) },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /trop long/i)
})

test('POST /cli-token — label avec espaces de bord → trim avant stockage', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-trim-label' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: '   laptop-perso   ' },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().label, 'laptop-perso')
})

test('POST /cli-token — token clair retourné UNIQUEMENT à la création + hash stocké sans préfixe', { skip: SKIP }, async () => {
  // Garantie cryptographique :
  //   - le hash en DB est SHA-256 du secret SEUL (sans préfixe opl_)
  //   - donc on peut rétrocompat les anciens hex64 (PR #104) sans migration DB
  const admin = await seedAdmin(db, { entraId: 'oid-hash-check', displayName: 'Crypto Admin' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'crypto-test' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  const secret = body.token.slice(4) // strip "opl_"
  const expectedHash = crypto.createHash('sha256').update(secret).digest('hex')

  const { rows } = await db.query(
    `SELECT token_hash, entra_id, created_by, label FROM cli_tokens WHERE id = $1`,
    [body.id]
  )
  assert.equal(rows[0].token_hash, expectedHash, 'hash DB = SHA-256 du secret SANS le préfixe opl_')
  assert.equal(rows[0].entra_id, admin.entraId)
  assert.equal(rows[0].created_by, admin.displayName)
  assert.equal(rows[0].label, 'crypto-test')
})

test('POST /cli-token — TTL 90 jours appliqué via expires_at', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-ttl-check' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const before = Date.now()
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'ttl' },
  })
  const after = Date.now()
  const expiresAt = new Date(res.json().expires_at).getTime()
  const ninetyDays = 90 * 24 * 3600 * 1000
  // Borne large : expires_at - now() doit être entre 89 et 90 jours.
  assert.ok(expiresAt - before >= 89 * 24 * 3600 * 1000, `TTL trop court: ${(expiresAt - before)/86400000}j`)
  assert.ok(expiresAt - after <= ninetyDays + 1000, `TTL trop long: ${(expiresAt - after)/86400000}j`)
})

test('POST /cli-token — audit_logs enrichi avec token_id + expires_at', { skip: SKIP }, async () => {
  const admin = await seedAdmin(db, { entraId: 'oid-audit', displayName: 'Audit Admin' })
  const token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/auth/cli-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'audited-token' },
  })
  const tokenId = res.json().id
  const { rows: audits } = await db.query(
    `SELECT by_user, target, details FROM audit_logs
     WHERE action = 'cli_token_created' AND target = 'audited-token'`
  )
  assert.equal(audits.length, 1, '1 audit log attendu')
  assert.equal(audits[0].by_user, 'Audit Admin')
  // L'enrichissement vient de la fix PR #107 : sans token_id l'admin doit
  // joindre cli_tokens par label, ambigu si plusieurs tokens partagent le
  // même label.
  assert.equal(audits[0].details.token_id, tokenId)
  assert.ok(audits[0].details.expires_at, 'expires_at doit être présent dans le détail')
})
