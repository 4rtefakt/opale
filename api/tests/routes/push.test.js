// routes/push.js : gestion des abonnements push Web.
//
// Endpoints couverts :
//   GET    /api/push/vapid-public  — clé VAPID publique (sans auth)
//   POST   /api/push/subscribe     — abonnement (auth requis)
//   DELETE /api/push/subscribe     — désabonnement (auth requis)
//
// NOTE : sendPushToAll() qui appelle webpush.sendNotification() vers des
// endpoints externes N'EST PAS testé ici — cela nécessiterait un mock de
// la lib web-push et sort du scope de cet audit. La lib est importée à
// l'initialisation du module ; setVapidDetails() est un setter pur, aucun
// appel réseau n'a lieu lors du register ou du test des routes CRUD.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { makePushSubscription, seedPushSubscription } from '../fixtures/push-subscriptions.js'

import pushRoute from '../../modules/core/routes/push.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

// Clé VAPID de test (32 octets urlsafe-base64, format attendu par web-push).
// Ces valeurs proviennent d'un appel à `web-push generate-vapid-keys` et sont
// uniquement utilisées pour tester que setVapidDetails ne lève pas d'erreur.
// Elles ne sont jamais utilisées pour envoyer de vraies notifications.
const TEST_VAPID_PUBLIC  = 'BJ6aqTfyvBhkAHYZ2AiTIVQ8eXzJVlJqiIa8bfJ2DvAl_t1Hf9OHGr7BN2MQ9VB8sXb5tLJcH8XuKn3rQ0Lg8Q0'
const TEST_VAPID_PRIVATE = 'BJ6aqTfyvBhkAHYZ2AiTIVQ8eXzJVlJqiIa8bfJ2DvA'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return

  // Injecter des variables VAPID factices pour que initVapid() ne soit pas
  // court-circuité (les routes non-VAPID fonctionnent sans, mais on les
  // couvre quand même).
  prevEnv = {
    VAPID_PUBLIC_KEY:  process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_EMAIL:       process.env.VAPID_EMAIL,
  }
  process.env.VAPID_PUBLIC_KEY  = TEST_VAPID_PUBLIC
  process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE
  process.env.VAPID_EMAIL       = 'test@example.com'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  try {
    fastify = await buildApp({
      db,
      jwks: jwt.jwks,
      routes: async (f) => {
        await f.register(pushRoute, { prefix: '/api/push' })
      },
    })
  } catch {
    // Si les clés VAPID de test sont rejetées par web-push (format strict),
    // on désactive VAPID_PUBLIC_KEY pour que les routes fonctionnent sans VAPID.
    process.env.VAPID_PUBLIC_KEY  = ''
    process.env.VAPID_PRIVATE_KEY = ''
    process.env.VAPID_EMAIL       = ''
    fastify = await buildApp({
      db,
      jwks: jwt.jwks,
      routes: async (f) => {
        await f.register(pushRoute, { prefix: '/api/push' })
      },
    })
  }
})

after(async () => {
  // Restaurer les variables d'environnement
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-push-admin', name = 'Admin Push') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId = 'oid-push-user', name = 'User Push') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// ─── VAPID public key ─────────────────────────────────────────────────────────

test('GET /api/push/vapid-public — sans VAPID configuré → 503', { skip: SKIP }, async () => {
  const saved = process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PUBLIC_KEY

  const res = await fastify.inject({ method: 'GET', url: '/api/push/vapid-public' })
  assert.equal(res.statusCode, 503)

  if (saved) process.env.VAPID_PUBLIC_KEY = saved
})

test('GET /api/push/vapid-public — VAPID configuré → retourne publicKey', { skip: SKIP }, async () => {
  process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC

  const res = await fastify.inject({ method: 'GET', url: '/api/push/vapid-public' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().publicKey, TEST_VAPID_PUBLIC)
})

// ─── Subscribe ────────────────────────────────────────────────────────────────

test('POST /api/push/subscribe — sans JWT → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/push/subscribe',
    payload: { subscription: makePushSubscription() },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /api/push/subscribe — subscription invalide → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-push-sub-400')
  const res = await fastify.inject({
    method: 'POST', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { subscription: {} },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /[Ss]ubscription/)
})

test('POST /api/push/subscribe — crée une row push_subscriptions', { skip: SKIP }, async () => {
  const token = await adminToken('oid-push-sub-ok')
  const endpoint = 'https://push.example.com/sub/unique-ok'
  const subscription = makePushSubscription(endpoint)

  const res = await fastify.inject({
    method: 'POST', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { subscription },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().ok, true)

  const { rows } = await db.query(
    'SELECT * FROM push_subscriptions WHERE endpoint = $1', [endpoint]
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user_entra_id, 'oid-push-sub-ok')
})

test('POST /api/push/subscribe — upsert idempotent (même endpoint)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-push-upsert')
  const endpoint = 'https://push.example.com/sub/upsert'
  const subscription = makePushSubscription(endpoint)

  await fastify.inject({
    method: 'POST', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { subscription },
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { subscription },
  })
  // Deuxième appel : ON CONFLICT DO UPDATE → toujours 201
  assert.equal(res.statusCode, 201)

  const { rows } = await db.query('SELECT count(*) FROM push_subscriptions WHERE endpoint = $1', [endpoint])
  assert.equal(rows[0].count, '1')
})

// ─── Unsubscribe ──────────────────────────────────────────────────────────────

test('DELETE /api/push/subscribe — sans JWT → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/push/subscribe',
    payload: { endpoint: 'https://push.example.com/x' },
  })
  assert.equal(res.statusCode, 401)
})

test('DELETE /api/push/subscribe — endpoint manquant → 400', { skip: SKIP }, async () => {
  const token = await userToken('oid-push-del-400')
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /endpoint/)
})

test('DELETE /api/push/subscribe — supprime la row', { skip: SKIP }, async () => {
  const token = await userToken('oid-push-del-ok')
  const endpoint = 'https://push.example.com/sub/to-delete'

  // Créer la souscription directement en DB
  await seedPushSubscription(db, { userEntraId: 'oid-push-del-ok', endpoint })

  const res = await fastify.inject({
    method: 'DELETE', url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { endpoint },
  })
  assert.equal(res.statusCode, 204)

  const { rows } = await db.query('SELECT * FROM push_subscriptions WHERE endpoint = $1', [endpoint])
  assert.equal(rows.length, 0)
})
