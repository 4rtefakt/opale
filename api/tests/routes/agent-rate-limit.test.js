// Rate-limit des routes agent non authentifiées (/setup-log,
// /exchange-token) + plafond de taille du body de /setup-log.
//
// App montée comme en prod (api/index.js) : @fastify/rate-limit avec les
// options de lib/rate-limit.js, handler d'erreur global, routes agent.
// Suite séparée de agent.test.js : les compteurs rate-limit sont en mémoire
// et ne doivent pas interférer avec les autres tests agent.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import rateLimit from '@fastify/rate-limit'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { rateLimitOptions } from '../../lib/rate-limit.js'
import errorHandlerPlugin from '../../plugins/error-handler.js'

import agentRoute from '../../modules/inventory/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release

  fastify = await buildApp({
    db,
    registerAuth: false,
    routes: async (f) => {
      await f.register(rateLimit, rateLimitOptions)
      await f.register(errorHandlerPlugin)
      await f.register(agentRoute, { prefix: '/api/agent' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

const randomBearer = () => ({ authorization: `Bearer ${crypto.randomBytes(32).toString('hex')}` })

test('POST /setup-log — un Bearer aléatoire par requête n\'ouvre plus un compteur neuf (clé = IP seule)', { skip: SKIP }, async () => {
  // Route sans auth : avant, la clé IP|hash(Bearer) donnait un compteur
  // neuf à chaque Bearer inventé → quota contourné.
  const statuses = []
  for (let i = 0; i < 61; i++) {
    const res = await fastify.inject({
      method: 'POST', url: '/api/agent/setup-log',
      remoteAddress: '203.0.113.10',
      headers: randomBearer(),
      payload: { hostname: `PC-SPAM-${i}`, script: 'install', level: 'error', log: 'x' },
    })
    statuses.push(res.statusCode)
  }
  assert.deepEqual(statuses.slice(0, 60), Array(60).fill(204))
  assert.equal(statuses[60], 429, `61e requête : ${statuses[60]}`)

  // Une autre IP garde son propre quota.
  const other = await fastify.inject({
    method: 'POST', url: '/api/agent/setup-log',
    remoteAddress: '203.0.113.11',
    payload: { hostname: 'PC-OTHER', script: 'install', log: 'ok' },
  })
  assert.equal(other.statusCode, 204)
})

test('POST /setup-log — réponse 429 lisible (pas une 500)', { skip: SKIP }, async () => {
  let res
  for (let i = 0; i < 61; i++) {
    res = await fastify.inject({
      method: 'POST', url: '/api/agent/setup-log',
      remoteAddress: '203.0.113.20',
      payload: { hostname: 'PC-429', script: 'install', log: 'x' },
    })
  }
  assert.equal(res.statusCode, 429)
  assert.equal(res.json().error, 'Trop de requêtes')
})

test('POST /setup-log — body > 64 Kio → 413, rien n\'est journalisé', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/setup-log',
    remoteAddress: '203.0.113.30',
    payload: { hostname: 'PC-BIGLOG', script: 'install', log: 'A'.repeat(100 * 1024) },
  })
  assert.equal(res.statusCode, 413)
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'setup_script' AND by_user = 'PC-BIGLOG'`
  )
  assert.equal(n, 0)

  // Un log d'install de taille normale passe toujours (sans token, comme
  // les scripts Intune historiques).
  const ok = await fastify.inject({
    method: 'POST', url: '/api/agent/setup-log',
    remoteAddress: '203.0.113.30',
    payload: { hostname: 'PC-NORMALLOG', script: 'install', level: 'error', log: 'L'.repeat(20 * 1024) },
  })
  assert.equal(ok.statusCode, 204)
})

test('POST /exchange-token — Bearers aléatoires limités par IP (10/min)', { skip: SKIP }, async () => {
  const statuses = []
  for (let i = 0; i < 11; i++) {
    const res = await fastify.inject({
      method: 'POST', url: '/api/agent/exchange-token',
      remoteAddress: '203.0.113.40',
      headers: randomBearer(),
      payload: { hostname: 'PC-BRUTE' },
    })
    statuses.push(res.statusCode)
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401))
  assert.equal(statuses[10], 429)
})

test('routes agent authentifiées — clé IP|token conservée (deux agents derrière la même IP)', { skip: SKIP }, async () => {
  // /admin-credential (6/min) : deux tokens distincts depuis la même IP
  // (NAT d'un site) ne partagent pas leur quota.
  const hit = (headers) => fastify.inject({
    method: 'POST', url: '/api/agent/admin-credential',
    remoteAddress: '203.0.113.50',
    headers,
    payload: {},
  })
  const a = randomBearer()
  for (let i = 0; i < 6; i++) assert.equal((await hit(a)).statusCode, 401)
  assert.equal((await hit(a)).statusCode, 429)
  assert.equal((await hit(randomBearer())).statusCode, 401)
})
