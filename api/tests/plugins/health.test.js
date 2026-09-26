// GET /api/health : sonde sans authentification, sans information sensible,
// 503 si Postgres est en erreur ou muet, une seule requête DB en vol.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import healthPlugin from '../../plugins/health.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

after(closeSharedPool)

async function build(t, db, opts) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  app.decorate('db', db)
  await app.register(healthPlugin, opts)
  await app.ready()
  return app
}

test('base disponible : 200 { status: ok }, sans authentification ni cache', { skip: SKIP }, async (t) => {
  const { db, release } = await acquireSchema({ migrate: false })
  t.after(release)
  const app = await build(t, db)
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { status: 'ok' })
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('base en erreur : 503, sans le message d’erreur', async (t) => {
  const db = { query: async () => { throw new Error('password authentication failed for user "opale" at 10.0.0.5') } }
  const app = await build(t, db)
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), { status: 'unavailable' })
  assert.doesNotMatch(res.body, /password|opale|10\.0\.0\.5/)
})

test('base muette : 503 en temps borné', async (t) => {
  const db = { query: () => new Promise(() => {}) }
  const app = await build(t, db, { dbTimeoutMs: 100 })
  const t0 = Date.now()
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 503)
  assert.ok(Date.now() - t0 < 1000)
})

test('sondes concurrentes : une seule requête DB en vol', async (t) => {
  let calls = 0
  let answer
  const db = { query: () => { calls++; return new Promise((r) => { answer = r }) } }
  const app = await build(t, db)
  const pending = Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/api/health' }))
  await new Promise((r) => setTimeout(r, 20))
  answer({ rows: [{ '?column?': 1 }] })
  const responses = await Promise.all(pending)
  assert.equal(calls, 1)
  assert.ok(responses.every(r => r.statusCode === 200))
})

test('base lente : les sondes suivantes ne relancent pas de requête tant que la première n’est pas terminée', async (t) => {
  // Le délai de 2 s borne la RÉPONSE, pas la requête : si la sonde relançait
  // un SELECT 1 à chaque appel une fois le délai écoulé, un flot de sondes
  // non authentifiées occuperait tout le pool pendant un ralentissement.
  let calls = 0
  let answer
  const db = { query: () => { calls++; return new Promise((r) => { answer = r }) } }
  const app = await build(t, db, { dbTimeoutMs: 50 })

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 503)
  }
  assert.equal(calls, 1, 'une seule requête en vol malgré 3 sondes expirées')

  answer({ rows: [{ '?column?': 1 }] })
  await new Promise((r) => setTimeout(r, 10))
  const pending = app.inject({ method: 'GET', url: '/api/health' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, 2, 'nouvelle requête une fois la précédente terminée')
  answer({ rows: [{ '?column?': 1 }] })
  assert.equal((await pending).statusCode, 200)
})
