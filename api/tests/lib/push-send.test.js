// sendPushToAll (core/routes/push.js) : les notifications (alertes parc,
// conformité…) ne doivent partir QUE vers les souscriptions d'utilisateurs
// actuellement admins. /api/push/subscribe est ouvert à tout authentifié et
// un admin révoqué garde sa souscription en base.
//
// web-push est stubbé (mock.method sur sendNotification) : aucun appel réseau.

import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import webpush from 'web-push'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedPushSubscription } from '../fixtures/push-subscriptions.js'
import { sendPushToAll } from '../../modules/core/routes/push.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release
const prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  // Clés VAPID jetables, générées localement (format strict exigé par web-push).
  const keys = webpush.generateVAPIDKeys()
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL']) prevEnv[k] = process.env[k]
  process.env.VAPID_PUBLIC_KEY  = keys.publicKey
  process.env.VAPID_PRIVATE_KEY = keys.privateKey
  process.env.VAPID_EMAIL       = 'test@example.com'
  ;({ db, release } = await acquireSchema())
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('sendPushToAll — n\'envoie qu\'aux souscriptions des admins', { skip: SKIP }, async () => {
  await seedAdmin(db, { entraId: 'oid-push-send-admin', email: 'a@x' })
  await seedNonAdmin(db, { entraId: 'oid-push-send-user', email: 'u@x' })
  await seedPushSubscription(db, { userEntraId: 'oid-push-send-admin', endpoint: 'https://push.example.com/admin' })
  await seedPushSubscription(db, { userEntraId: 'oid-push-send-user',  endpoint: 'https://push.example.com/user' })
  // Souscription orpheline (user absent de users_cache) : jamais servie.
  await seedPushSubscription(db, { userEntraId: 'oid-push-send-ghost', endpoint: 'https://push.example.com/ghost' })

  const sent = []
  const spy = mock.method(webpush, 'sendNotification', async (sub) => { sent.push(sub.endpoint) })
  try {
    const fastify = { db, log: { warn() {} } }
    await sendPushToAll(fastify, { title: 'Alerte', body: 'Disque plein' })
  } finally {
    spy.mock.restore()
  }
  assert.deepEqual(sent, ['https://push.example.com/admin'])
})
