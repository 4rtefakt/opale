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
import { prepareThread, createTicketFromMapping } from '../../modules/email-bridge/lib/inbox.js'

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
  conversationId = `conv-${Math.random().toString(36).slice(2)}`,
  internetMessageId = `<inbox-${Math.random().toString(36).slice(2)}@x>`,
  receivedAt = new Date().toISOString(),
  headers = [],
  ticketId = null,
} = {}) {
  const raw = {
    id: `graph-${Math.random().toString(36).slice(2)}`,
    internetMessageId,
    conversationId,
    from: { emailAddress: { address: fromAddress, name: fromName } },
    subject, bodyPreview,
    receivedDateTime: receivedAt,
    internetMessageHeaders: headers,
  }
  const { rows } = await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, conversation_id, graph_message_id, mailbox,
       direction, from_address, subject, received_at, raw, action,
       processed_at, classifier_result, ticket_id)
    VALUES ($1, $2, $3, 'helpdesk@test', 'inbound', $4, $5, $9, $6, $7,
            now(), $8, $10)
    RETURNING id
  `, [
    internetMessageId, conversationId,
    raw.id, fromAddress, subject, JSON.stringify(raw), action,
    JSON.stringify({ intent: 'new_ticket', confidence: 0.8 }),
    receivedAt, ticketId,
  ])
  return rows[0].id
}

// Graph simulé (aucun appel réseau) : jeton + réponses par route. `handler`
// reçoit l'URL décodée et retourne le body JSON ; undefined → 404.
function withFakeGraph(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    let body, status = 200
    if (/login\.microsoftonline\.com/.test(u)) body = { access_token: 'tok', expires_in: 3600 }
    else {
      body = handler(decodeURIComponent(u).replace(/\+/g, ' '))
      if (body === undefined) { status = 404; body = { error: 'not found' } }
    }
    return { ok: status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }
  }
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original })
}

const hour = (n) => new Date(Date.now() - n * 3600_000).toISOString()

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

// ─── Fil complet : « → Ticket » ramasse les autres mails du même fil ─────────

test('POST /inbox/:id/to-ticket — les autres mails du fil (à trier ou mis de côté) sont versés dans le ticket, dans l\'ordre',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-thread-adm', 'Thread Admin')
    const conv = `conv-thread-${Math.random().toString(36).slice(2)}`
    const first  = await seedInboxMapping(db, { conversationId: conv, subject: 'Imprimante HS', bodyPreview: 'Premier mail', receivedAt: hour(3), fromName: 'Alice' })
    const second = await seedInboxMapping(db, { conversationId: conv, subject: 'RE: Imprimante HS', bodyPreview: 'Deuxième mail', receivedAt: hour(2), fromName: 'Alice', action: 'skipped_other' })
    const third  = await seedInboxMapping(db, { conversationId: conv, subject: 'RE: Imprimante HS', bodyPreview: 'Troisième mail', receivedAt: hour(1), fromName: 'Alice' })
    const other  = await seedInboxMapping(db, { subject: 'Autre sujet', bodyPreview: 'Sans rapport', receivedAt: hour(1) })

    // L'admin clique sur le mail le plus récent.
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${third}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 201)
    const { ticket, absorbed } = res.json()
    assert.equal(absorbed, 3)
    assert.equal(ticket.title, 'Imprimante HS')
    assert.match(ticket.description, /^Fil de 3 mails — premier mail de Alice le /)

    const { rows: msgs } = await db.query(
      `SELECT content, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`, [ticket.id]
    )
    assert.deepEqual(msgs.map(m => m.content), ['Premier mail', 'Deuxième mail', 'Troisième mail'])

    const { rows: maps } = await db.query(
      `SELECT id, ticket_id, action FROM email_thread_mapping WHERE id = ANY($1::uuid[])`, [[first, second, third]]
    )
    assert.equal(maps.length, 3)
    for (const m of maps) { assert.equal(m.ticket_id, ticket.id); assert.equal(m.action, 'message_appended') }

    const { rows: untouched } = await db.query(`SELECT ticket_id, action FROM email_thread_mapping WHERE id = $1`, [other])
    assert.equal(untouched[0].ticket_id, null)
    assert.equal(untouched[0].action, 'pending_review')
  }
)

test('POST /inbox/:id/to-ticket — fil relié par In-Reply-To / References sans conversationId commun',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-thread-hdr')
    const parentId = `<parent-hdr-${Math.random().toString(36).slice(2)}@x>`
    const parent = await seedInboxMapping(db, { internetMessageId: parentId, subject: 'VPN', bodyPreview: 'Le VPN tombe', receivedAt: hour(5) })
    const child  = await seedInboxMapping(db, { subject: 'Re: VPN', bodyPreview: 'Toujours pareil', receivedAt: hour(4),
      headers: [{ name: 'In-Reply-To', value: parentId }, { name: 'References', value: parentId }] })
    const grandchildId = `<gc-hdr-${Math.random().toString(36).slice(2)}@x>`
    // Un mail qui RÉPOND au mail cliqué (référence dans l'autre sens).
    const clickedId = `<clicked-hdr-${Math.random().toString(36).slice(2)}@x>`
    const clicked = await seedInboxMapping(db, { internetMessageId: clickedId, subject: 'Re: VPN', bodyPreview: 'Relance', receivedAt: hour(3),
      headers: [{ name: 'References', value: `${parentId} ${grandchildId}` }] })
    const later = await seedInboxMapping(db, { subject: 'Re: VPN', bodyPreview: 'Encore', receivedAt: hour(2),
      headers: [{ name: 'In-Reply-To', value: clickedId }] })

    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${clicked}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().absorbed, 3, 'parent (References) + cliqué + réponse au cliqué')
    const { rows } = await db.query(`SELECT id FROM email_thread_mapping WHERE ticket_id = $1`, [res.json().ticket.id])
    assert.deepEqual(rows.map(r => r.id).sort(), [parent, clicked, later].sort())
    const { rows: c } = await db.query(`SELECT ticket_id FROM email_thread_mapping WHERE id = $1`, [child])
    assert.equal(c[0].ticket_id, null, 'un mail qui ne référence que le parent n\'est pas du fil du mail cliqué')
  }
)

test('POST /inbox/:id/to-ticket — un mail du fil déjà rattaché à un autre ticket n\'est pas repris',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-thread-linked')
    const { rows: t } = await db.query(`INSERT INTO tickets (title) VALUES ('Existant') RETURNING id`)
    const conv = `conv-linked-${Math.random().toString(36).slice(2)}`
    await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Déjà dans un ticket', receivedAt: hour(2), action: 'message_appended', ticketId: t[0].id })
    const pending = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Nouveau', receivedAt: hour(1) })

    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${pending}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().absorbed, 1)
    const { rows: msgs } = await db.query(`SELECT content FROM ticket_messages WHERE ticket_id = $1`, [t[0].id])
    assert.equal(msgs.length, 0, 'ticket existant intact')
  }
)

test('POST /inbox/:id/to-ticket — mails plus anciens du fil récupérés depuis Graph (jamais ingérés)',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-thread-graph')
    const conv = `conv-graph-${Math.random().toString(36).slice(2)}`
    const clicked = await seedInboxMapping(db, { conversationId: conv, subject: 'RE: Écran noir', bodyPreview: 'Relance du demandeur', receivedAt: hour(1), fromName: 'Bob', fromAddress: 'bob@ex.fr' })
    const olderId = `<older-graph-${Math.random().toString(36).slice(2)}@x>`
    const older = {
      id: 'graph-older', internetMessageId: olderId, conversationId: conv, subject: 'Écran noir',
      bodyPreview: 'Mail initial avant la mise en place du polling', receivedDateTime: hour(30),
      from: { emailAddress: { address: 'bob@ex.fr', name: 'Bob' } }, parentFolderId: 'inbox-id', isDraft: false,
    }
    const replyFromIt = {
      id: 'graph-sent', internetMessageId: `<sent-graph-${Math.random().toString(36).slice(2)}@x>`, conversationId: conv,
      subject: 'RE: Écran noir', bodyPreview: 'Avez-vous essayé de redémarrer ?', receivedDateTime: hour(20),
      from: { emailAddress: { address: 'helpdesk@test', name: 'Helpdesk' } }, parentFolderId: 'sent-id', isDraft: false,
    }
    const draft = { ...older, id: 'graph-draft', internetMessageId: '<draft@x>', isDraft: true, bodyPreview: 'brouillon' }

    const res = await withFakeGraph((url) => {
      if (/mailFolders\/sentitems$/.test(url)) return { id: 'sent-id' }
      if (/mailFolders\/\w+$/.test(url)) return undefined
      if (/\/messages\?/.test(url) && url.includes(`conversationId eq '${conv}'`)) return { value: [replyFromIt, draft, older] }
      if (/\/messages\/graph-older$/.test(url)) return { ...older, body: { contentType: 'text', content: 'Corps complet du mail initial' } }
      if (/\/messages\/[^/]+$/.test(url)) return undefined   // pas de corps complet → fallback bodyPreview
      return undefined
    }, () => fastify.inject({
      method: 'POST', url: `/api/email/inbox/${clicked}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    }))
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().absorbed, 3)

    const { rows: msgs } = await db.query(
      `SELECT author, content FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`, [res.json().ticket.id]
    )
    assert.deepEqual(msgs.map(m => [m.author, m.content]), [
      ['Bob', 'Corps complet du mail initial'],
      ['Helpdesk', 'Avez-vous essayé de redémarrer ?'],
      ['Bob', 'Relance du demandeur'],
    ])
    // Les mails Graph sont désormais ingérés et rattachés : une réponse
    // ultérieure référençant le mail initial sera matchée par matchThread.
    const { rows: maps } = await db.query(
      `SELECT internet_message_id, direction, action FROM email_thread_mapping WHERE ticket_id = $1 ORDER BY received_at`, [res.json().ticket.id]
    )
    assert.equal(maps.length, 3)
    assert.equal(maps[0].internet_message_id, olderId)
    assert.equal(maps[0].direction, 'inbound')
    assert.equal(maps[1].direction, 'outbound', 'réponse depuis les Éléments envoyés')
    assert.ok(maps.every(m => m.action === 'message_appended'))
  }
)

test('POST /inbox/:id/to-ticket — Graph en panne → le fil DB suffit, pas de 500',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-thread-graphko')
    const conv = `conv-ko-${Math.random().toString(36).slice(2)}`
    await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Un', receivedAt: hour(2) })
    const b = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Deux', receivedAt: hour(1) })
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('réseau coupé (test)') }
    try {
      const res = await fastify.inject({
        method: 'POST', url: `/api/email/inbox/${b}/to-ticket`,
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(res.statusCode, 201)
      assert.equal(res.json().absorbed, 2)
    } finally { globalThis.fetch = original }
  }
)

test('POST /inbox/:id/to-ticket — mail transféré : la citation (fil d\'origine) est conservée',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-fwd')
    const m = await seedInboxMapping(db, { subject: 'TR: Accès partagé', bodyPreview: 'x' })
    const content = 'Pour info, voir ci-dessous.\n\nDe : Carole\nEnvoyé : lundi\nObjet : Accès partagé\n\nJe n\'arrive pas à ouvrir le dossier.'
    const res = await withFakeGraph((url) => {
      if (/\/messages\/[^/?]+$/.test(url)) return { body: { contentType: 'text', content } }
      return undefined
    }, () => fastify.inject({
      method: 'POST', url: `/api/email/inbox/${m}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    }))
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().ticket.title, 'Accès partagé')
    const { rows } = await db.query(`SELECT content FROM ticket_messages WHERE ticket_id = $1`, [res.json().ticket.id])
    assert.match(rows[0].content, /Je n'arrive pas à ouvrir le dossier/, 'le fil cité est gardé pour un transfert')
  }
)

// ─── GET /inbox : taille du fil, GET /inbox/:id/thread, GET /inbox/:id/body ──

test('GET /inbox — thread_count = mails du même fil encore rattachables',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-threadcount')
    const conv = `conv-count-${Math.random().toString(36).slice(2)}`
    await seedInboxMapping(db, { conversationId: conv, subject: 'Compte A', receivedAt: hour(3) })
    await seedInboxMapping(db, { conversationId: conv, subject: 'Compte B', receivedAt: hour(2), action: 'skipped_other' })
    const c = await seedInboxMapping(db, { conversationId: conv, subject: 'Compte C', receivedAt: hour(1) })
    const solo = await seedInboxMapping(db, { subject: 'Solo' })

    const res = await fastify.inject({ method: 'GET', url: '/api/email/inbox', headers: { authorization: `Bearer ${token}` } })
    const rows = res.json()
    assert.equal(rows.find(r => r.id === c).thread_count, 3)
    assert.equal(rows.find(r => r.id === solo).thread_count, 1)
    assert.equal(rows.find(r => r.id === c).from_name, 'Alice')
    assert.equal(rows.find(r => r.id === c).conversation_id, conv)
  }
)

test('GET /inbox/:id/thread — mails du fil dans l\'ordre chronologique',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-threadlist')
    const conv = `conv-list-${Math.random().toString(36).slice(2)}`
    const a = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'A', receivedAt: hour(3) })
    const b = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'B', receivedAt: hour(2), action: 'skipped_other' })
    const c = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'C', receivedAt: hour(1) })

    const res = await fastify.inject({ method: 'GET', url: `/api/email/inbox/${c}/thread`, headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().map(r => [r.id, r.body_preview, r.action]),
      [[a, 'A', 'pending_review'], [b, 'B', 'skipped_other'], [c, 'C', 'pending_review']])

    const ghost = await fastify.inject({ method: 'GET', url: '/api/email/inbox/00000000-0000-0000-0000-000000000000/thread', headers: { authorization: `Bearer ${token}` } })
    assert.equal(ghost.statusCode, 404)
  }
)

test('GET /inbox/:id/body — corps complet via Graph, sinon aperçu',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-body')
    const m = await seedInboxMapping(db, { bodyPreview: 'Aperçu court' })

    const full = await withFakeGraph((url) => {
      if (/\/messages\/[^/?]+$/.test(url)) return { body: { contentType: 'html', content: '<p>Bonjour,</p><p>Corps <b>complet</b>.</p>' } }
      return undefined
    }, () => fastify.inject({ method: 'GET', url: `/api/email/inbox/${m}/body`, headers: { authorization: `Bearer ${token}` } }))
    assert.equal(full.statusCode, 200)
    assert.equal(full.json().source, 'graph')
    assert.equal(full.json().body_text, 'Bonjour,\n\nCorps complet.')

    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('réseau coupé (test)') }
    try {
      const fallback = await fastify.inject({ method: 'GET', url: `/api/email/inbox/${m}/body`, headers: { authorization: `Bearer ${token}` } })
      assert.equal(fallback.statusCode, 200)
      assert.deepEqual(fallback.json(), { body_text: 'Aperçu court', source: 'preview' })
    } finally { globalThis.fetch = original }

    const acl = await userAuth('oid-inbox-body-acl')
    const denied = await fastify.inject({ method: 'GET', url: `/api/email/inbox/${m}/body`, headers: { authorization: `Bearer ${acl.token}` } })
    assert.equal(denied.statusCode, 403)
  }
)

// ─── POST /inbox/:id/attach ──────────────────────────────────────────────────

test('POST /inbox/:id/attach — verse le mail (et son fil) dans un ticket existant, le rouvre s\'il était résolu',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-attach')
    const { rows: t } = await db.query(
      `INSERT INTO tickets (title, status, resolved_at) VALUES ('Wifi', 'resolved', now()) RETURNING id`
    )
    const conv = `conv-attach-${Math.random().toString(36).slice(2)}`
    await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Ça recommence', receivedAt: hour(2) })
    const m = await seedInboxMapping(db, { conversationId: conv, bodyPreview: 'Toujours rien', receivedAt: hour(1) })

    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${m}/attach`,
      headers: { authorization: `Bearer ${token}` }, payload: { ticket_id: t[0].id },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ticket_id: t[0].id, appended: 2 })

    const { rows: msgs } = await db.query(
      `SELECT type, content FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`, [t[0].id]
    )
    assert.deepEqual(msgs.map(x => [x.type, x.content]), [
      ['comment', 'Ça recommence'], ['comment', 'Toujours rien'], ['system', 'Ticket rouvert : nouveau mail rattaché'],
    ])
    const { rows: tk } = await db.query(`SELECT status, resolved_at FROM tickets WHERE id = $1`, [t[0].id])
    assert.equal(tk[0].status, 'open')
    assert.equal(tk[0].resolved_at, null)
    const { rows: maps } = await db.query(`SELECT COUNT(*)::int AS n FROM email_thread_mapping WHERE ticket_id = $1 AND action = 'message_appended'`, [t[0].id])
    assert.equal(maps[0].n, 2)

    // Déjà lié → 409
    const again = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${m}/attach`,
      headers: { authorization: `Bearer ${token}` }, payload: { ticket_id: t[0].id },
    })
    assert.equal(again.statusCode, 409)
  }
)

test('POST /inbox/:id/attach — ticket inconnu → 404, ticket_id manquant → 400, non-admin → 403',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-attach-err')
    const m = await seedInboxMapping(db, {})
    const missing = await fastify.inject({ method: 'POST', url: `/api/email/inbox/${m}/attach`, headers: { authorization: `Bearer ${token}` }, payload: {} })
    assert.equal(missing.statusCode, 400)
    const ghost = await fastify.inject({ method: 'POST', url: `/api/email/inbox/${m}/attach`, headers: { authorization: `Bearer ${token}` }, payload: { ticket_id: '00000000-0000-0000-0000-000000000000' } })
    assert.equal(ghost.statusCode, 404)
    const bad = await fastify.inject({ method: 'POST', url: `/api/email/inbox/${m}/attach`, headers: { authorization: `Bearer ${token}` }, payload: { ticket_id: 'pas-un-uuid' } })
    assert.equal(bad.statusCode, 404)
    const { rows } = await db.query(`SELECT ticket_id, action FROM email_thread_mapping WHERE id = $1`, [m])
    assert.equal(rows[0].ticket_id, null); assert.equal(rows[0].action, 'pending_review')
    const u = await userAuth('oid-inbox-attach-acl')
    const denied = await fastify.inject({ method: 'POST', url: `/api/email/inbox/${m}/attach`, headers: { authorization: `Bearer ${u.token}` }, payload: { ticket_id: '00000000-0000-0000-0000-000000000000' } })
    assert.equal(denied.statusCode, 403)
  }
)

// ─── POST /inbox/:id/dismiss { whole_thread } ────────────────────────────────

test('POST /inbox/:id/dismiss — whole_thread ignore aussi les autres mails à trier du fil',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-dismiss-thread')
    const conv = `conv-dis-${Math.random().toString(36).slice(2)}`
    const a = await seedInboxMapping(db, { conversationId: conv, receivedAt: hour(2) })
    const b = await seedInboxMapping(db, { conversationId: conv, receivedAt: hour(1) })
    const other = await seedInboxMapping(db, {})
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${b}/dismiss`,
      headers: { authorization: `Bearer ${token}` }, payload: { whole_thread: true },
    })
    assert.equal(res.statusCode, 200)
    const { rows } = await db.query(`SELECT id, action FROM email_thread_mapping WHERE id = ANY($1::uuid[])`, [[a, b, other]])
    const byId = Object.fromEntries(rows.map(r => [r.id, r.action]))
    assert.equal(byId[a], 'skipped_other'); assert.equal(byId[b], 'skipped_other'); assert.equal(byId[other], 'pending_review')
  }
)

// ─── Robustesse : ids, demandeur, concurrence ────────────────────────────────

test('routes /inbox/:id/* — id non UUID → 404 « introuvable », jamais une erreur Postgres',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-baduuid')
    for (const [method, url] of [
      ['GET', '/api/email/inbox/not-a-uuid/body'], ['GET', '/api/email/inbox/not-a-uuid/thread'],
      ['POST', '/api/email/inbox/not-a-uuid/to-ticket'], ['POST', '/api/email/inbox/not-a-uuid/dismiss'],
    ]) {
      const res = await fastify.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
      assert.equal(res.statusCode, 404, `${method} ${url}`)
      assert.equal(res.json().error, 'Mail introuvable')
    }
    const m = await seedInboxMapping(db)
    const res = await fastify.inject({
      method: 'POST', url: `/api/email/inbox/${m}/attach`,
      headers: { authorization: `Bearer ${token}` }, payload: { ticket_id: 'pas-un-uuid' },
    })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error, 'Ticket introuvable')
  }
)

test('POST /inbox/:id/to-ticket — le demandeur est l\'expéditeur du mail converti, pas le plus ancien du fil',
  { skip: SKIP }, async () => {
    const { token } = await adminAuth('oid-inbox-requester')
    const alice = await seedNonAdmin(db, { entraId: 'oid-req-alice', displayName: 'Alice', email: 'alice-req@ex.fr' })
    const bob   = await seedNonAdmin(db, { entraId: 'oid-req-bob',   displayName: 'Bob',   email: 'bob-req@ex.fr' })
    const conv = `conv-req-${Math.random().toString(36).slice(2)}`
    await seedInboxMapping(db, { conversationId: conv, subject: 'Salle de réunion', fromAddress: alice.email, fromName: 'Alice', receivedAt: hour(48), action: 'skipped_other' })
    const clicked = await seedInboxMapping(db, { conversationId: conv, subject: 'RE: Salle de réunion', fromAddress: bob.email, fromName: 'Bob', receivedAt: hour(1) })

    const res = await withFakeGraph(() => undefined, () => fastify.inject({
      method: 'POST', url: `/api/email/inbox/${clicked}/to-ticket`,
      headers: { authorization: `Bearer ${token}` },
    }))
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().absorbed, 2)
    assert.equal(res.json().ticket.user_id, bob.entraId, 'demandeur = expéditeur du mail cliqué (celui annoncé par la page de tri)')
    const { rows } = await db.query(
      `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1 ORDER BY user_entra_id`, [res.json().ticket.id]
    )
    assert.deepEqual(rows.map(r => r.user_entra_id), [alice.entraId, bob.entraId], 'Alice concernée, Bob demandeur')
    assert.equal(rows.find(r => r.user_entra_id === bob.entraId).role, 'requester')
    assert.notEqual(rows.find(r => r.user_entra_id === alice.entraId).role, 'requester')
  }
)

test('createTicketFromMapping — fil préparé hors transaction, mail rattaché ailleurs entre-temps → pas versé deux fois',
  { skip: SKIP }, async () => {
    const conv = `conv-race-${Math.random().toString(36).slice(2)}`
    const clicked = await seedInboxMapping(db, { conversationId: conv, subject: 'Imprimante', bodyPreview: 'Premier', receivedAt: hour(2) })
    const sibling = await seedInboxMapping(db, { conversationId: conv, subject: 'RE: Imprimante', bodyPreview: 'Second', receivedAt: hour(1) })

    // Phase 1 : deux mails vus, corps chargés (Graph muet → bodyPreview).
    const prepared = await withFakeGraph(() => undefined, () => prepareThread(db, null, clicked))
    assert.equal(prepared.bodies.size, 2)

    // Entre-temps, un autre admin rattache le second mail à un autre ticket.
    const { rows: t } = await db.query(`INSERT INTO tickets (title) VALUES ('Autre demande') RETURNING id`)
    await db.query(`UPDATE email_thread_mapping SET ticket_id = $1, action = 'message_appended' WHERE id = $2`, [t[0].id, sibling])

    // Phase 2 : le fil DB relu sous verrou fait foi.
    const client = await db.connect()
    let tk
    try {
      await client.query('BEGIN')
      tk = await withFakeGraph(() => undefined, () => createTicketFromMapping(client, null, {
        mappingId: clicked, byEntraId: 'oid-race', byName: 'Race', prepared,
      }))
      await client.query('COMMIT')
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err } finally { client.release() }

    assert.equal(tk.absorbed_count, 1, 'seul le mail cliqué est versé')
    const { rows: msgs } = await db.query(`SELECT content FROM ticket_messages WHERE ticket_id = $1`, [tk.id])
    assert.deepEqual(msgs.map(m => m.content), ['Premier'])
    const { rows: link } = await db.query(`SELECT ticket_id FROM email_thread_mapping WHERE id = $1`, [sibling])
    assert.equal(link[0].ticket_id, t[0].id, 'le mail rattaché ailleurs y reste')
  }
)
