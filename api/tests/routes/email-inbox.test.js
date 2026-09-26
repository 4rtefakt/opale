// Phase 3 — routes /api/email/inbox (vue "Mails à trier").
//
// On teste à travers l'API publique (Fastify inject) le flow complet :
// seed mapping en pending_review → list → to-ticket OU dismiss.
//
// getMessage côté Graph va échouer en environnement test (pas de token
// app Entra) — c'est volontaire : createTicketFromMapping a un fallback
// vers bodyPreview du raw, qu'on remplit explicitement dans le seed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import emailRoute from '../../modules/email-bridge/routes/email.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(emailRoute, { prefix: '/api/email' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function adminAuth(entraId = 'oid-inbox-admin', name = 'Inbox Admin') {
  const a = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: a, token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }) }
}
async function userAuth(entraId = 'oid-inbox-user', name = 'Inbox User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

async function seedInboxMapping(db, {
  fromAddress = 'alice@ex.fr', fromName = 'Alice', subject = 'Mon problème',
  bodyPreview = 'Bonjour, mon poste ne démarre plus.',
  action = 'pending_review',
} = {}) {
  const internetMessageId = `<inbox-${Math.random().toString(36).slice(2)}@x>`
  const raw = {
    id: `graph-${Math.random().toString(36).slice(2)}`,
    internetMessageId,
    from: { emailAddress: { address: fromAddress, name: fromName } },
    subject, bodyPreview,
    receivedDateTime: new Date().toISOString(),
  }
  const { rows } = await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, conversation_id, graph_message_id, mailbox,
       direction, from_address, subject, received_at, raw, action,
       processed_at, classifier_result)
    VALUES ($1, $2, $3, 'helpdesk@test', 'inbound', $4, $5, now(), $6, $7,
            now(), $8)
    RETURNING id
  `, [
    internetMessageId, `conv-${Math.random().toString(36).slice(2)}`,
    raw.id, fromAddress, subject, JSON.stringify(raw), action,
    JSON.stringify({ intent: 'new_ticket', confidence: 0.8 }),
  ])
  return rows[0].id
}

// ─── GET /api/email/inbox ────────────────────────────────────────────────────

test('GET /inbox — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/email/inbox' })
  assert.equal(res.statusCode, 401)
})

test('GET /inbox — non-admin → 403', { skip: SKIP }, async () => {
  const { token } = await userAuth('oid-inbox-acl')
  const res = await fastify.inject({
    method: 'GET', url: '/api/email/inbox',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET /inbox — retourne uniquement les mappings pending_review par défaut',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-list-pending')
    const pendingId  = await seedInboxMapping(db, { subject: 'Pending', action: 'pending_review' })
    const skippedId  = await seedInboxMapping(db, { subject: 'Skipped', action: 'skipped_other' })

    const res = await fastify.inject({
      method: 'GET', url: '/api/email/inbox',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const ids = res.json().map(r => r.id)
    assert.ok(ids.includes(pendingId))
    assert.ok(!ids.includes(skippedId), 'skipped_other ne doit pas apparaître par défaut')
  }
)

test('GET /inbox — body_preview est exposé depuis raw',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-bodypreview')
    await seedInboxMapping(db, { subject: 'Avec preview', bodyPreview: 'Le contenu visible.' })

    const res = await fastify.inject({
      method: 'GET', url: '/api/email/inbox',
      headers: { authorization: `Bearer ${token}` },
    })
    const row = res.json().find(r => r.subject === 'Avec preview')
    assert.ok(row, 'le mail seedé est présent')
    assert.equal(row.body_preview, 'Le contenu visible.')
  }
)

test('GET /inbox — body_preview HTML legacy → strippé à la lecture (défense en profondeur)',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-html-strip')
    await seedInboxMapping(db, {
      subject: 'Avec HTML legacy',
      bodyPreview: '<p>Bonjour,</p><p>Compte <strong>bloqué</strong>.</p>',
    })

    const res = await fastify.inject({
      method: 'GET', url: '/api/email/inbox',
      headers: { authorization: `Bearer ${token}` },
    })
    const row = res.json().find(r => r.subject === 'Avec HTML legacy')
    assert.ok(row, 'mail seedé présent')
    assert.ok(!/<p>|<strong>/.test(row.body_preview),
      'body_preview ne doit contenir aucune balise HTML après strip défensif')
    assert.match(row.body_preview, /Bonjour/, 'le contenu texte reste lisible')
    assert.match(row.body_preview, /bloqué/i)
  }
)

test('GET /inbox — classifier_result inclus (advisory)',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-classifier')
    await seedInboxMapping(db, { subject: 'Classifier inclus' })

    const res = await fastify.inject({
      method: 'GET', url: '/api/email/inbox',
      headers: { authorization: `Bearer ${token}` },
    })
    const row = res.json().find(r => r.subject === 'Classifier inclus')
    assert.equal(row.classifier_result.intent, 'new_ticket')
    assert.equal(row.classifier_result.confidence, 0.8)
  }
)

// ─── GET /inbox/count ────────────────────────────────────────────────────────

test('GET /inbox/count — compte les pending_review uniquement',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-count')
    const before = await fastify.inject({
      method: 'GET', url: '/api/email/inbox/count',
      headers: { authorization: `Bearer ${token}` },
    })
    const pendingBefore = before.json().pending

    await seedInboxMapping(db, { action: 'pending_review' })
    await seedInboxMapping(db, { action: 'pending_review' })
    await seedInboxMapping(db, { action: 'skipped_other' })

    const after = await fastify.inject({
      method: 'GET', url: '/api/email/inbox/count',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(after.json().pending, pendingBefore + 2)
  }
)

// ─── POST /inbox/:id/to-ticket ───────────────────────────────────────────────

test('POST /inbox/:id/to-ticket — crée un ticket + repointe le mapping',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-tot-adm', 'Tot Admin')
    const mappingId = await seedInboxMapping(db, {
      fromAddress: 'tot-user@ex.fr', fromName: 'Tot User',
      subject: 'Re: ticket à créer', bodyPreview: 'Body via bodyPreview fallback.',
    })

    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 201)
    const tk = res.json().ticket
    assert.ok(tk.id)
    // Title nettoyé du préfixe Re:
    assert.equal(tk.title, 'ticket à créer')
    // Description = ligne d'origine "Mail de X reçu le Y"
    assert.match(tk.description, /^Mail de Tot User reçu le /)
    assert.equal(tk.source, 'email')
    assert.equal(tk.is_auto, true)

    // Premier ticket_message contient le body (fallback bodyPreview ici car
    // getMessage Graph plante en env test → fallback bien testé au passage).
    const { rows: msgs } = await db.query(
      `SELECT type, author, content FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
    )
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'comment')
    assert.equal(msgs[0].author, 'Tot User')
    assert.match(msgs[0].content, /Body via bodyPreview fallback/)

    // Mapping repointé
    const { rows: mapRows } = await db.query(
      `SELECT ticket_id, action FROM email_thread_mapping WHERE id = $1`, [mappingId]
    )
    assert.equal(mapRows[0].ticket_id, tk.id)
    assert.equal(mapRows[0].action, 'message_appended')
  }
)

test('POST /inbox/:id/to-ticket — corps Graph contenant NUL → ticket créé, NUL retiré (pas de 500)',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-nul-adm', 'Nul Admin')
    const mappingId = await seedInboxMapping(db, { subject: 'Poste bloqué' })
    // Graph simulé (aucun appel réseau) : corps complet avec un caractère NUL.
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      const body = /login\.microsoftonline\.com/.test(String(url))
        ? { access_token: 'tok', expires_in: 3600 }
        : { body: { contentType: 'text', content: 'Bonjour\u0000, mon poste ne démarre plus.' } }
      return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }
    }
    try {
      const res = await fastify.inject({
        method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(res.statusCode, 201)
      const { rows } = await db.query(`SELECT content FROM ticket_messages WHERE ticket_id = $1`, [res.json().ticket.id])
      assert.deepEqual(rows.map(r => r.content), ['Bonjour, mon poste ne démarre plus.'])
    } finally {
      globalThis.fetch = original
    }
  }
)

test('POST /inbox/:id/to-ticket — déjà lié → 409',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-tot-twice')
    const mappingId = await seedInboxMapping(db, { subject: 'Double' })
    const first = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(first.statusCode, 201)
    const second = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(second.statusCode, 409)
  }
)

test('POST /inbox/:id/to-ticket — mapping inexistant → 404',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-tot-ghost')
    const res = await fastify.inject({
      method: 'POST', url: '/api/email/inbox/00000000-0000-0000-0000-000000000000/to-ticket',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 404)
  }
)

test('POST /inbox/:id/to-ticket — non-admin → 403',
  { skip: SKIP }, async () => {
    const { token } = await userAuth('oid-inbox-tot-acl')
    const mappingId = await seedInboxMapping(db, { subject: 'ACL' })
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 403)
  }
)

// ─── POST /inbox/:id/dismiss ─────────────────────────────────────────────────

test('POST /inbox/:id/dismiss — passe action → skipped_other',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-dismiss')
    const mappingId = await seedInboxMapping(db, { subject: 'Newsletter à virer' })
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const { rows } = await db.query(`SELECT action FROM email_thread_mapping WHERE id = $1`, [mappingId])
    assert.equal(rows[0].action, 'skipped_other')
  }
)

test('POST /inbox/:id/dismiss — déjà dismissed → 200 no-op',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-dismiss-twice')
    const mappingId = await seedInboxMapping(db, {})
    await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    })
    const second = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(second.statusCode, 200)
  }
)

test('POST /inbox/:id/dismiss — mapping déjà converti en ticket → 409',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-dismiss-linked')
    const mappingId = await seedInboxMapping(db, {})
    // Convert d'abord en ticket
    await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    // Maintenant tenter de dismiss → action n'est plus pending_review
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 409)
  }
)

test('POST /inbox/:id/dismiss — non-admin → 403',
  { skip: SKIP }, async () => {
    const { token } = await userAuth('oid-inbox-dismiss-acl')
    const mappingId = await seedInboxMapping(db, {})
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${mappingId}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 403)
  }
)
