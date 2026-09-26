// GET /api/email/status — état du polling par boîte, dont le blocage en
// cours (mail en échec qui retient le curseur, cf. poll-cursor.js), lu dans
// le setting d'état `mail.cursor_state.<boîte>`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import emailRoute from '../../modules/email-bridge/routes/email.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify, jwt

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()
  fastify = await buildApp({
    db, jwks: jwt.jwks,
    routes: async (f) => { await f.register(emailRoute, { prefix: '/api/email' }) },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

test('GET /api/email/status : blocage en cours exposé par boîte, rien pour une boîte saine ou un état périmé',
  { skip: SKIP }, async () => {
    const a = await seedAdmin(db, { entraId: 'oid-status-admin', displayName: 'Status Admin', email: 'status@x' })
    const token = await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })

    const cursor = '2026-05-10T09:00:00.000Z'
    const retry = {
      id: 'AAMk-1', internet_message_id: '<bloque@example.com>', attempts: 7,
      error: 'panne', first_at: '2026-05-10T10:00:00.000Z', alerted: true,
    }
    // Premier échec, il y a quelques secondes : transitoire, pas affiché.
    const fresh = { ...retry, id: 'AAMk-2', attempts: 1, first_at: new Date().toISOString() }
    await db.query(`UPDATE settings SET value = 'a@example.com,b@example.com,c@example.com,d@example.com' WHERE key = 'mail.inboxes'`)
    await db.query(`UPDATE settings SET value = 's@example.com' WHERE key = 'mail.sent_mailboxes'`)
    await db.query(`
      INSERT INTO settings (key, value) VALUES
        ('mail.cursor.a@example.com', $1), ('mail.cursor_state.a@example.com', $2),
        ('mail.cursor.b@example.com', $1), ('mail.cursor_state.b@example.com', $3),
        ('mail.cursor.c@example.com', $1), ('mail.cursor_state.c@example.com', $4),
        ('mail.cursor.d@example.com', $1), ('mail.cursor_state.d@example.com', $5),
        ('mail.sent_cursor.s@example.com', $1), ('mail.sent_cursor_state.s@example.com', $2)
    `, [
      cursor,
      JSON.stringify({ at: cursor, done: [], retry }),
      JSON.stringify({ at: cursor, done: [], retry: null }),
      // État d'un autre curseur (curseur modifié à la main) : ignoré, comme par le worker.
      JSON.stringify({ at: '2026-05-01T00:00:00.000Z', done: [], retry }),
      JSON.stringify({ at: cursor, done: [], retry: fresh }),
    ])

    const res = await fastify.inject({ method: 'GET', url: '/api/email/status', headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    const byAddr = Object.fromEntries(body.mailboxes.map(m => [m.address, m]))
    const expected = { since: retry.first_at, attempts: 7, error: 'panne', internet_message_id: '<bloque@example.com>' }
    assert.deepEqual(byAddr['a@example.com'].blocked, expected)
    assert.equal(byAddr['b@example.com'].blocked, null)
    assert.equal(byAddr['c@example.com'].blocked, null)
    assert.equal(byAddr['d@example.com'].blocked, null, 'premier échec récent : pas de faux signal')

    // Éléments envoyés (mail.sent_mailboxes) : même information.
    assert.deepEqual(body.sent_mailboxes, [{ address: 's@example.com', cursor, blocked: expected }])
  }
)

test('GET /api/email/status : réservé aux admins (403 sinon)',
  { skip: SKIP }, async () => {
    const u = await seedNonAdmin(db, { entraId: 'oid-status-user', displayName: 'Status User', email: 'status-user@x' })
    const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
    const res = await fastify.inject({ method: 'GET', url: '/api/email/status', headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.statusCode, 403)
  }
)
