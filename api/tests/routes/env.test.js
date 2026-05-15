// routes/env.js : GET /env.js — injecte window.ENV côté client.
// Couvre : Content-Type, body window.ENV, clés ENV attendues,
// Cache-Control no-store, DB (settings branding).
//
// env.js est wrappé dans fastify-plugin (fp) — il décore l'instance
// avec invalidateBrandingCache. Aucune auth requise.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'

import envRoute from '../../modules/core/routes/env.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = {
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
    API_BASE_URL:    process.env.API_BASE_URL,
  }
  process.env.ENTRA_TENANT_ID = 'test-tenant-env'
  process.env.ENTRA_CLIENT_ID = 'test-client-env'
  process.env.API_BASE_URL    = '/api'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  fastify = await buildApp({
    db,
    registerAuth: false,
    routes: async (f) => {
      // env.js est un fp() plugin — on le register directement sans prefix.
      await f.register(envRoute)
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

// ─── Content-Type ─────────────────────────────────────────────────────────────

test('GET /env.js — Content-Type application/javascript', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  assert.equal(res.statusCode, 200)
  assert.ok(
    res.headers['content-type']?.includes('application/javascript'),
    `Content-Type attendu application/javascript, reçu ${res.headers['content-type']}`
  )
})

// ─── Cache-Control ────────────────────────────────────────────────────────────

test('GET /env.js — Cache-Control: no-store', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  assert.equal(res.headers['cache-control'], 'no-store')
})

// ─── Body window.ENV ─────────────────────────────────────────────────────────

test('GET /env.js — body contient window.ENV = ', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  assert.ok(
    res.body.includes('window.ENV =') || res.body.includes('.ENV ='),
    `body devrait contenir une affectation ENV, reçu : ${res.body.slice(0, 200)}`
  )
})

test('GET /env.js — ENV contient les clés attendues', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  // Extraire le JSON depuis "(typeof window !== 'undefined' ? window : self).ENV = {...};"
  // Non-greedy + anchor sur `};\n` pour ne pas déborder sur la 2e
  // assignation (window.OPALE) ajoutée après l'objet ENV.
  const match = res.body.match(/\.ENV\s*=\s*(\{[\s\S]+?\});\s*\n/)
  assert.ok(match, 'impossible de parser le JSON ENV depuis le body')
  const env = JSON.parse(match[1])
  assert.ok('ENTRA_TENANT_ID' in env, 'ENTRA_TENANT_ID manquant')
  assert.ok('ENTRA_CLIENT_ID' in env, 'ENTRA_CLIENT_ID manquant')
  assert.ok('API_BASE_URL'    in env, 'API_BASE_URL manquant')
  assert.ok('BRANDING'        in env, 'BRANDING manquant')
})

test('GET /env.js — ENTRA_CLIENT_ID = valeur env', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  // Non-greedy + anchor sur `};\n` pour ne pas déborder sur la 2e
  // assignation (window.OPALE) ajoutée après l'objet ENV.
  const match = res.body.match(/\.ENV\s*=\s*(\{[\s\S]+?\});\s*\n/)
  const env = JSON.parse(match[1])
  assert.equal(env.ENTRA_CLIENT_ID, 'test-client-env')
})

// ─── BRANDING defaults ────────────────────────────────────────────────────────

test('GET /env.js — BRANDING contient product_name (default si settings vide)', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  // Non-greedy + anchor sur `};\n` pour ne pas déborder sur la 2e
  // assignation (window.OPALE) ajoutée après l'objet ENV.
  const match = res.body.match(/\.ENV\s*=\s*(\{[\s\S]+?\});\s*\n/)
  const env = JSON.parse(match[1])
  assert.ok(typeof env.BRANDING.product_name === 'string', 'BRANDING.product_name devrait être une string')
  // Défaut = 'Opale' quand la table settings est vide.
  assert.ok(env.BRANDING.product_name.length > 0)
})

test('GET /env.js — BRANDING reflète settings DB', { skip: SKIP }, async () => {
  // Écrire un org.name custom dans la table settings
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('org.name', 'Test Org Name')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  )
  // Invalider le cache en appelant le décorateur (mis en place par fp)
  fastify.invalidateBrandingCache()

  const res = await fastify.inject({ method: 'GET', url: '/env.js' })
  // Non-greedy + anchor sur `};\n` pour ne pas déborder sur la 2e
  // assignation (window.OPALE) ajoutée après l'objet ENV.
  const match = res.body.match(/\.ENV\s*=\s*(\{[\s\S]+?\});\s*\n/)
  const env = JSON.parse(match[1])
  assert.equal(env.BRANDING.org_name, 'Test Org Name')
})
