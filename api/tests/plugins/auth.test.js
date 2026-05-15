// Tests d'intégration du plugin auth (api/plugins/auth.js).
//
// Pourquoi vrai PG : authenticate + requireAdmin font des SELECT sur
// cli_tokens / users_cache. Mocker le pool aurait masqué les bugs
// SQL réels (cf. design doc PR1, choix DB option b+c).
// Pourquoi vrai jose : on stubbe uniquement fetch globalThis pour
// le JWKS Microsoft (cf. helpers/jwt.js). La validation crypto +
// iss + aud est exercée.
//
// Skip silencieusement si PG_TEST_URL absent — les helpers DB pures
// continuent à tourner.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip auth suite'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = {
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant-id'
  process.env.ENTRA_CLIENT_ID = 'test-client-id'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: (f) => {
      // Route de test : exerce authenticate puis renvoie le payload + identity
      // que le caller pourra introspecter.
      f.get('/whoami', { preHandler: f.authenticate }, async (req) => ({
        payload: req.jwtPayload,
        identity: f.getUserIdentity(req),
        isAdmin: await f.isAdmin(req),
      }))
      f.get('/admin-only', { preHandler: [f.authenticate, f.requireAdmin] }, async () => ({ ok: true }))
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

// ─── authenticate — chemins d'erreur ─────────────────────────────────────────

test('authenticate — pas d\'Authorization header → 401 "Token manquant"', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/whoami' })
  assert.equal(res.statusCode, 401)
  assert.match(res.json().error, /manquant/i)
})

test('authenticate — Authorization sans prefix "Bearer " → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: 'Token abc' },
  })
  assert.equal(res.statusCode, 401)
  assert.match(res.json().error, /manquant/i)
})

test('authenticate — Bearer string aléatoire (ni opl_ ni JWT ni hex64) → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: 'Bearer nimporte-quoi' },
  })
  assert.equal(res.statusCode, 401)
  assert.match(res.json().error, /invalide/i)
})

test('authenticate — Bearer JWT format invalide (2 segments) → 401', { skip: SKIP }, async () => {
  // Le check strict "exactement 3 segments" a été introduit en PR #107.
  // Un token a.b passe le test legacy `includes('.')` mais n'est pas un
  // JWT — 401 explicite plutôt qu'erreur jose obscure.
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: 'Bearer a.b' },
  })
  assert.equal(res.statusCode, 401)
})

// ─── authenticate — chemin JWT ──────────────────────────────────────────────

test('authenticate — Bearer JWT valide injecte jwtPayload', { skip: SKIP }, async () => {
  const token = await jwt.sign({
    oid: 'oid-jwt-1',
    name: 'Alice JWT',
    preferred_username: 'alice@example.com',
  })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.payload.oid, 'oid-jwt-1')
  assert.equal(body.identity.entraId, 'oid-jwt-1')
  assert.equal(body.identity.displayName, 'Alice JWT')
  assert.equal(body.identity.email, 'alice@example.com')
})

test('authenticate — Bearer JWT issuer invalide → 401', { skip: SKIP }, async () => {
  const token = await jwt.sign(
    { oid: 'oid-x', name: 'X', preferred_username: 'x@x' },
    { iss: 'https://attacker.example.com/v2.0' },
  )
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — Bearer JWT audience invalide → 401', { skip: SKIP }, async () => {
  const token = await jwt.sign(
    { oid: 'oid-x', name: 'X', preferred_username: 'x@x' },
    { aud: 'attacker-client-id' },
  )
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — Bearer JWT signature trafiquée → 401', { skip: SKIP }, async () => {
  const token = await jwt.sign({ oid: 'oid-x', name: 'X', preferred_username: 'x@x' })
  // Flip un char à la fin de la signature.
  const segs = token.split('.')
  const lastChar = segs[2].slice(-1)
  segs[2] = segs[2].slice(0, -1) + (lastChar === 'A' ? 'B' : 'A')
  const tampered = segs.join('.')
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${tampered}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — Bearer JWT audience `api://<clientId>` accepté', { skip: SKIP }, async () => {
  // Le plugin accepte 2 audiences : clientId direct OU api://clientId.
  // Vérifie la 2e variante (utilisée pour les access tokens v1).
  const token = await jwt.sign(
    { oid: 'oid-api', name: 'API user', preferred_username: 'api@x' },
    { aud: `api://${process.env.ENTRA_CLIENT_ID}` },
  )
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
})

// ─── authenticate — chemin opl_ (CLI tokens) ────────────────────────────────

async function seedCliToken({ secret, entraId, displayName = 'CLI User', email = 'cli@x', label = 'test-token', expiresAt = null, revokedAt = null }) {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (entra_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [entraId, displayName, email]
  )
  const hash = crypto.createHash('sha256').update(secret).digest('hex')
  await db.query(
    `INSERT INTO cli_tokens (entra_id, label, token_hash, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [entraId, label, hash, expiresAt, revokedAt]
  )
  return hash
}

test('authenticate — Bearer opl_<hex> valide injecte jwtPayload synthétique', { skip: SKIP }, async () => {
  const secret = crypto.randomBytes(32).toString('hex')
  await seedCliToken({ secret, entraId: 'oid-cli-1', displayName: 'CLI Alice', email: 'cli-alice@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer opl_${secret}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.payload.oid, 'oid-cli-1')
  assert.equal(body.identity.displayName, 'CLI Alice')
  assert.equal(body.identity.email, 'cli-alice@x')
})

test('authenticate — Bearer opl_<hex> inconnu → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer opl_${'00'.repeat(32)}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — Bearer opl_<hex> expiré → 401', { skip: SKIP }, async () => {
  const secret = crypto.randomBytes(32).toString('hex')
  await seedCliToken({
    secret, entraId: 'oid-cli-exp',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer opl_${secret}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — Bearer opl_<hex> revoked → 401', { skip: SKIP }, async () => {
  const secret = crypto.randomBytes(32).toString('hex')
  await seedCliToken({
    secret, entraId: 'oid-cli-rev',
    revokedAt: new Date().toISOString(),
  })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer opl_${secret}` },
  })
  assert.equal(res.statusCode, 401)
})

test('authenticate — opl_<hex> met à jour last_used_at (fire-and-forget)', { skip: SKIP }, async () => {
  const secret = crypto.randomBytes(32).toString('hex')
  await seedCliToken({ secret, entraId: 'oid-cli-last' })
  const before = await db.query(
    `SELECT last_used_at FROM cli_tokens WHERE entra_id = $1`,
    ['oid-cli-last']
  )
  assert.equal(before.rows[0].last_used_at, null)

  await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer opl_${secret}` },
  })

  // L'UPDATE est best-effort (.catch warn) donc on attend un tick pour
  // laisser la promesse se résoudre côté DB.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setTimeout(r, 50))

  const after = await db.query(
    `SELECT last_used_at FROM cli_tokens WHERE entra_id = $1`,
    ['oid-cli-last']
  )
  assert.ok(after.rows[0].last_used_at !== null, 'last_used_at doit être renseigné après use')
})

// ─── authenticate — chemin legacy hex64 ─────────────────────────────────────

test('authenticate — Bearer hex64 (sans préfixe opl_) accepté en legacy', { skip: SKIP }, async () => {
  // Compat PR #104 (avant que le préfixe opl_ devienne obligatoire). À
  // retirer une fois tous les anciens tokens expirés (90 j max).
  const secret = crypto.randomBytes(32).toString('hex') // 64 hex chars
  await seedCliToken({ secret, entraId: 'oid-legacy', displayName: 'Legacy CLI', email: 'leg@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${secret}` }, // hex64 nu
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().payload.oid, 'oid-legacy')
})

test('authenticate — string de 64 chars non-hex (a..z) → 401 (pas legacy)', { skip: SKIP }, async () => {
  // Le regex `/^[0-9a-f]{64}$/i` doit refuser ce qui ressemble à du hex
  // mais ne l'est pas (ex: lettres > f). Sinon on aurait une fausse
  // discrimination CLI vs JWT.
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${'g'.repeat(64)}` },
  })
  assert.equal(res.statusCode, 401)
})

// ─── requireAdmin / isAdmin ─────────────────────────────────────────────────

test('requireAdmin — non authentifié → 401', { skip: SKIP }, async () => {
  // Pas d'auth → preHandler authenticate échoue déjà en 401 avant
  // requireAdmin. C'est l'ordre de chain qu'on teste : on n'arrive
  // jamais à requireAdmin sans payload.
  const res = await fastify.inject({ method: 'GET', url: '/admin-only' })
  assert.equal(res.statusCode, 401)
})

test('requireAdmin — JWT valide mais is_admin=false → 403', { skip: SKIP }, async () => {
  // Seed la row mais is_admin=false (default).
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ('oid-nonadmin', 'Bob non-admin', 'bob@x', false)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = false`
  )
  const token = await jwt.sign({ oid: 'oid-nonadmin', name: 'Bob', preferred_username: 'bob@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/admin-only',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /autoris/i)
})

test('requireAdmin — JWT valide + is_admin=true → 200', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ('oid-admin', 'Carol admin', 'carol@x', true)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = true`
  )
  const token = await jwt.sign({ oid: 'oid-admin', name: 'Carol', preferred_username: 'carol@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/admin-only',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('isAdmin — variante non-bloquante retourne false sur user sans row', { skip: SKIP }, async () => {
  // Pas de row users_cache pour cet oid → isAdmin retourne false sans
  // 401/403 (la route appelante décide). Cf. cas d'usage : routes qui
  // appliquent une ACL custom (admin OR propriétaire).
  const token = await jwt.sign({ oid: 'oid-orphan', name: 'Orphan', preferred_username: 'o@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().isAdmin, false)
})

// ─── getUserIdentity — fallbacks oid/sub + email/preferred_username/upn ─────

test('getUserIdentity — fallback sub si oid absent', { skip: SKIP }, async () => {
  // Tokens v1 (sts.windows.net) n'ont pas oid → on retombe sur sub.
  const token = await jwt.sign(
    { sub: 'sub-fallback', name: 'Dave', preferred_username: 'dave@x' },
  )
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().identity.entraId, 'sub-fallback')
})

test('getUserIdentity — fallback upn / email si preferred_username absent', { skip: SKIP }, async () => {
  // Order de fallback : preferred_username > upn > email.
  const token = await jwt.sign({ oid: 'oid-e', name: 'E', upn: 'e-upn@x', email: 'e-mail@x' })
  const res = await fastify.inject({
    method: 'GET', url: '/whoami',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.json().identity.email, 'e-upn@x')
})
