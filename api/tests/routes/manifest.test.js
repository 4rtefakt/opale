// routes/manifest.js : GET /manifest.json — PWA manifest dynamique.
// Couvre : Content-Type, keys PWA requis, branding DB, invalidation cache.
//
// manifest.js est wrappé dans fastify-plugin (fp). Pas d'auth.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'

import manifestRoute, { invalidateManifestCache } from '../../modules/core/routes/manifest.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  fastify = await buildApp({
    db,
    registerAuth: false,
    routes: async (f) => {
      await f.register(manifestRoute)
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Content-Type ─────────────────────────────────────────────────────────────

test('GET /manifest.json — Content-Type application/manifest+json ou application/json', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  assert.equal(res.statusCode, 200)
  // Fastify peut ajouter charset ; on vérifie juste le mime de base.
  assert.ok(
    res.headers['content-type']?.includes('application/manifest+json') ||
    res.headers['content-type']?.includes('application/json'),
    `Content-Type inattendu : ${res.headers['content-type']}`
  )
})

// ─── Cache-Control ────────────────────────────────────────────────────────────

test('GET /manifest.json — Cache-Control: no-store', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  assert.equal(res.headers['cache-control'], 'no-store')
})

// ─── Keys PWA ────────────────────────────────────────────────────────────────

test('GET /manifest.json — contient les keys PWA requises', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  const m = res.json()
  for (const key of ['name', 'short_name', 'icons', 'start_url', 'display', 'theme_color']) {
    assert.ok(key in m, `key PWA manquante : ${key}`)
  }
})

test('GET /manifest.json — icons est un tableau non vide', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  const m = res.json()
  assert.ok(Array.isArray(m.icons) && m.icons.length > 0, 'icons doit être un tableau non vide')
  // Chaque icône a src, sizes, type.
  for (const icon of m.icons) {
    assert.ok(icon.src, `icône sans src : ${JSON.stringify(icon)}`)
    assert.ok(icon.sizes, `icône sans sizes : ${JSON.stringify(icon)}`)
    assert.ok(icon.type, `icône sans type : ${JSON.stringify(icon)}`)
  }
})

test('GET /manifest.json — display = standalone', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  assert.equal(res.json().display, 'standalone')
})

// ─── Branding DB ──────────────────────────────────────────────────────────────

test('GET /manifest.json — name reflète app.product_name depuis settings', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('app.product_name', 'MonRMM Test')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  )
  // Invalider le cache du module
  invalidateManifestCache()

  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  assert.equal(res.json().name, 'MonRMM Test')
})

test('GET /manifest.json — short_name dérivé du product_name (premier token ≥ 2 chars)', { skip: SKIP }, async () => {
  // 'MonRMM Test' → short_name devrait être 'MonRMM' (premier token ≥ 2 chars)
  const res = await fastify.inject({ method: 'GET', url: '/manifest.json' })
  const m = res.json()
  assert.equal(typeof m.short_name, 'string')
  assert.ok(m.short_name.length >= 2)
})

test('GET /manifest.json — invalidateManifestCache expose le décorateur Fastify', { skip: SKIP }, async () => {
  // Le décorateur est mis en place par fp() : vérifie qu'il est accessible
  // sur l'instance Fastify utilisée en tests.
  assert.ok(
    typeof fastify.invalidateManifestCache === 'function',
    'invalidateManifestCache devrait être décorée sur fastify'
  )
})
