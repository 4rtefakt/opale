// routes/tickets.js : CRUD tickets + transitions + ACL.
//
// Focus PR5 : les chemins sécu (ACL admin-OR-requester-OR-assignee) et la
// validation business (priority, titre, transition statut). Le reste
// (recherche full-text, tags, filtres multi-params) reste extrapolable
// depuis le pattern testé ici.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'

import ticketsRoute from '../../modules/tickets/routes/tickets.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt
let prevEnv = {}
// Stub mutable de l'assistant IA (évite tout appel Ollama réseau). Les
// tests le réassignent selon le cas (succès / panne).
let _aiStub = async () => 'Suggestion IA de test.'

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    // Override de l'assistant IA : la route utilise fastify.generateSuggestion
    // s'il existe, sinon le module réel. On délègue à _aiStub (mutable).
    decorators: { generateSuggestion: (...args) => _aiStub(...args) },
    routes: async (f) => {
      await f.register(ticketsRoute, { prefix: '/api/tickets' })
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

async function adminAuth(entraId = 'oid-tk-admin', name = 'Tickets Admin') {
  const a = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: a, token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }) }
}
async function userAuth(entraId = 'oid-tk-user', name = 'Tickets User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

async function createTicketAs(token, body) {
  return fastify.inject({
    method: 'POST', url: '/api/tickets/',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  })
}

// ─── POST / — création ──────────────────────────────────────────────────────

test('POST / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'POST', url: '/api/tickets/', payload: { title: 'x' } })
  assert.equal(res.statusCode, 401)
})

test('POST / — titre manquant → 400', { skip: SKIP }, async () => {
  const { token } = await adminAuth()
  const res = await createTicketAs(token, {})
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /[Tt]itre/)
})

test('POST / — happy path : priority default "normal", created_by capturé', { skip: SKIP }, async () => {
  const { user, token } = await adminAuth('oid-tk-create', 'Creator Admin')
  const res = await createTicketAs(token, { title: 'Test ticket', description: 'desc' })
  assert.equal(res.statusCode, 201)
  const tk = res.json()
  assert.equal(tk.title, 'Test ticket')
  assert.equal(tk.description, 'desc')
  assert.equal(tk.priority, 'normal')
  assert.equal(tk.status, 'open')
  assert.equal(tk.created_by_entra_id, user.entraId)
  assert.equal(tk.created_by_name, user.displayName)
  assert.equal(tk.is_auto, false)
  assert.deepEqual(tk.tags, [])
})

test('POST / — source=auto → is_auto=true (création par hook)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tk-auto')
  const res = await createTicketAs(token, { title: 'Hook ticket', source: 'auto' })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().is_auto, true)
  assert.equal(res.json().source, 'auto')
})

// ─── GET /:id — ACL admin OR requester OR assignee ─────────────────────────

test('GET /:id — 404 sur id inconnu', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tk-getunknown')
  const res = await fastify.inject({
    method: 'GET', url: '/api/tickets/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — non-admin non-requester non-assignee → 403', { skip: SKIP }, async () => {
  // Critique sécu : un user lambda ne doit pas pouvoir lire un ticket dont
  // il n'est ni requester ni assignee, sauf à être admin.
  const owner = await adminAuth('oid-tk-owner', 'Owner Admin')
  const other = await userAuth('oid-tk-outsider', 'Outsider')
  const created = await createTicketAs(owner.token, { title: 'Confidentiel', user_id: owner.user.entraId })
  assert.equal(created.statusCode, 201)
  const id = created.json().id

  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${other.token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET /:id — requester (user_id) y accède', { skip: SKIP }, async () => {
  const creator = await adminAuth('oid-tk-creator-r', 'Creator')
  const requester = await userAuth('oid-tk-requester', 'Requester')
  const created = await createTicketAs(creator.token, {
    title: 'Pour moi', user_id: requester.user.entraId,
  })
  const id = created.json().id

  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${requester.token}` },
  })
  assert.equal(res.statusCode, 200, `requester doit voir son propre ticket`)
})

test('GET /:id — assignee (assigned_to_entra_id) y accède', { skip: SKIP }, async () => {
  const creator = await adminAuth('oid-tk-creator-a', 'Creator')
  const assignee = await userAuth('oid-tk-assignee', 'Assignee')
  const created = await createTicketAs(creator.token, {
    title: 'À traiter',
    assigned_to_entra_id: assignee.user.entraId,
    assigned_to_name: assignee.user.displayName,
  })
  const id = created.json().id

  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${assignee.token}` },
  })
  assert.equal(res.statusCode, 200, `assignee doit voir le ticket qui lui est assigné`)
})

test('GET /:id — admin accède à n\'importe quel ticket', { skip: SKIP }, async () => {
  const creator = await userAuth('oid-tk-creator-u', 'User Creator')
  const admin = await adminAuth('oid-tk-admin-everywhere', 'Admin Everywhere')
  const created = await createTicketAs(creator.token, { title: 'Visible admin' })
  const id = created.json().id

  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 200)
})

// ─── PATCH /:id — transitions de statut ────────────────────────────────────

test('PATCH /:id — non-membre → 403', { skip: SKIP }, async () => {
  const owner = await adminAuth('oid-tk-patch-owner', 'Patch Owner')
  const other = await userAuth('oid-tk-patch-outsider', 'Outsider')
  const created = await createTicketAs(owner.token, { title: 'Read-only', user_id: owner.user.entraId })
  const id = created.json().id

  const res = await fastify.inject({
    method: 'PATCH', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${other.token}` },
    payload: { status: 'resolved' },
  })
  assert.equal(res.statusCode, 403)
})

test('PATCH /:id — transition open → resolved : crée message system + set resolved_at', { skip: SKIP }, async () => {
  // Side effect métier vérifié : le PATCH sur status doit AUSSI insérer un
  // ticket_messages 'system' avec un label FR, sinon le fil n'a pas de
  // trace de la transition côté UI.
  const admin = await adminAuth('oid-tk-resolve', 'Resolver Admin')
  const created = await createTicketAs(admin.token, { title: 'Bug', user_id: admin.user.entraId })
  const id = created.json().id

  const res = await fastify.inject({
    method: 'PATCH', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { status: 'resolved' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'resolved')
  assert.ok(res.json().resolved_at, 'resolved_at doit être set automatiquement')

  // Message system inséré.
  const { rows } = await db.query(
    `SELECT type, content FROM ticket_messages WHERE ticket_id = $1 AND type = 'system'`,
    [id]
  )
  assert.equal(rows.length, 1, 'exactement 1 message system pour la transition')
  assert.match(rows[0].content, /résolu/i)
})

test('PATCH /:id — aucun champ → 400', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-empty-patch')
  const created = await createTicketAs(admin.token, { title: 'Static' })
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/tickets/${created.json().id}`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

// ─── POST /:id/messages — ajout commentaire ────────────────────────────────

test('POST /:id/messages — non-membre → 403', { skip: SKIP }, async () => {
  const owner = await adminAuth('oid-tk-msg-owner', 'Msg Owner')
  const other = await userAuth('oid-tk-msg-outsider', 'Outsider')
  const created = await createTicketAs(owner.token, { title: 'Private', user_id: owner.user.entraId })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/messages`,
    headers: { authorization: `Bearer ${other.token}` },
    payload: { content: 'spam' },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /:id/messages — contenu manquant → 400', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-msg-empty')
  const created = await createTicketAs(admin.token, { title: 'No content' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

test('POST /:id/messages — owner ajoute un message + bump updated_at', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-msg-add', 'Message Author')
  const created = await createTicketAs(admin.token, { title: 'Discussion', user_id: admin.user.entraId })
  const id = created.json().id
  const updatedBefore = new Date(created.json().updated_at).getTime()

  // Petit délai pour que updated_at soit forcément > created updated_at.
  await new Promise(r => setTimeout(r, 50))

  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { content: 'Premier commentaire' },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().content, 'Premier commentaire')
  assert.equal(res.json().author, 'Message Author')
  // Phase 1c : default = note interne, email_sent_at set (= ne sera pas
  // picked par l'outbox tant que /send-by-mail n'est pas appelé).
  assert.equal(res.json().type, 'internal_note', 'default type = internal_note')
  assert.ok(res.json().email_sent_at, 'email_sent_at posé à la création (note interne)')

  const { rows } = await db.query('SELECT updated_at FROM tickets WHERE id = $1', [id])
  assert.ok(new Date(rows[0].updated_at).getTime() > updatedBefore,
    'updated_at doit être bumped après ajout message')
})

test('POST /:id/messages — type invalide → 400', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-msg-badtype')
  const created = await createTicketAs(admin.token, { title: 'Bad type' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { content: 'X', type: 'pas_un_type' },
  })
  assert.equal(res.statusCode, 400)
})

// ─── POST /:id/messages/:msgId/send-by-mail — Phase 1c ────────────────────

test('send-by-mail : note interne + ticket d\'origine mail → flip vers comment + email_sent_at=NULL',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-send-mail', 'Admin Send')
    const created = await createTicketAs(admin.token, { title: 'Ticket mail' })
    const ticketId = created.json().id

    // Seed un email_thread_mapping inbound pour ce ticket (= origine mail).
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, ticket_id)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
    `, [`<seed-${Math.random().toString(36).slice(2)}@x>`, ticketId])

    // Création note interne via /messages
    const msgRes = await fastify.inject({
      method: 'POST', url: `/api/tickets/${ticketId}/messages`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { content: 'Bonjour, je traite votre demande.' },
    })
    assert.equal(msgRes.statusCode, 201)
    const msgId = msgRes.json().id
    assert.equal(msgRes.json().type, 'internal_note')

    // Action : envoyer par mail
    const sendRes = await fastify.inject({
      method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgId}/send-by-mail`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(sendRes.statusCode, 200)
    assert.equal(sendRes.json().type, 'comment', 'type flippé en comment')
    assert.equal(sendRes.json().email_sent_at, null, 'email_sent_at NULL = outbox va le piquer')
  }
)

test('send-by-mail : ticket sans origine mail → 409', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-send-noinbound')
  const created = await createTicketAs(admin.token, { title: 'Ticket manuel' })
  const ticketId = created.json().id

  const msgRes = await fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { content: 'Note' },
  })
  const msgId = msgRes.json().id

  const sendRes = await fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgId}/send-by-mail`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(sendRes.statusCode, 409)
  assert.match(sendRes.json().error, /origine mail/)
})

test('send-by-mail : double-clic / message déjà commenté → idempotent (200, no-op)',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-send-idem')
    const created = await createTicketAs(admin.token, { title: 'Idem' })
    const ticketId = created.json().id
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, ticket_id)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
    `, [`<idem-${Math.random().toString(36).slice(2)}@x>`, ticketId])

    const msgRes = await fastify.inject({
      method: 'POST', url: `/api/tickets/${ticketId}/messages`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { content: 'Ack' },
    })
    const msgId = msgRes.json().id

    await fastify.inject({
      method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgId}/send-by-mail`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    // 2e appel : message déjà 'comment', on ne re-flippe pas, on renvoie tel quel
    const second = await fastify.inject({
      method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgId}/send-by-mail`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().type, 'comment')
  }
)

test('send-by-mail : non-membre → 403', { skip: SKIP }, async () => {
  const owner = await adminAuth('oid-tk-send-owner')
  const other = await userAuth('oid-tk-send-outsider')
  const created = await createTicketAs(owner.token, { title: 'Privé' })
  const msgRes = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/messages`,
    headers: { authorization: `Bearer ${owner.token}` },
    payload: { content: 'X' },
  })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/messages/${msgRes.json().id}/send-by-mail`,
    headers: { authorization: `Bearer ${other.token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('retry-send : message dead-letter → reset (repris par l\'outbox)', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-retry')
  const created = await createTicketAs(admin.token, { title: 'Retry' })
  const ticketId = created.json().id
  // Seed un message en dead-letter directement.
  const { rows } = await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, outbound_attempts, outbound_failed_at, outbound_error)
    VALUES ($1, 'comment', 'Admin', 'En échec', NULL, 5, now(), 'Graph 503')
    RETURNING id
  `, [ticketId])
  const msgId = rows[0].id

  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgId}/retry-send`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 200)

  const { rows: after } = await db.query(
    `SELECT outbound_attempts, outbound_failed_at, outbound_error, email_sent_at FROM ticket_messages WHERE id = $1`, [msgId]
  )
  assert.equal(after[0].outbound_attempts, 0)
  assert.equal(after[0].outbound_failed_at, null)
  assert.equal(after[0].outbound_error, null)
  assert.equal(after[0].email_sent_at, null, 'remis dans la file outbox')
})

test('retry-send : message pas en échec → 404', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-retry-404')
  const created = await createTicketAs(admin.token, { title: 'Pas échec' })
  const ticketId = created.json().id
  const msgRes = await fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { content: 'Note normale' },
  })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/messages/${msgRes.json().id}/retry-send`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── Assistant IA ──────────────────────────────────────────────────────────

test('POST /:id/ai-suggest — crée une bulle ai_suggestion (non envoyée)', { skip: SKIP }, async () => {
  _aiStub = async () => 'Vérifiez le câble réseau puis redémarrez.'
  const admin = await adminAuth('oid-tk-ai-ok', 'AI Admin')
  const tk = await createTicketAs(admin.token, { title: 'PC lent' })
  const id = tk.json().id

  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/ai-suggest`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 201)
  const msg = res.json()
  assert.equal(msg.type, 'ai_suggestion')
  assert.equal(msg.author, 'Assistant IA')
  assert.match(msg.content, /câble réseau/)
  // email_sent_at posé → jamais pické par l'outbox.
  assert.ok(msg.email_sent_at, 'ai_suggestion ne doit pas être envoyable')

  // Exposé dans le fil via GET /:id.
  const det = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.ok(det.json().messages.some(m => m.type === 'ai_suggestion'))
})

test('POST /:id/ai-suggest — assistant désactivé → 409', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value='false' WHERE key='tickets.assistant.enabled'`)
  try {
    const admin = await adminAuth('oid-tk-ai-off')
    const id = (await createTicketAs(admin.token, { title: 'X' })).json().id
    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${id}/ai-suggest`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.statusCode, 409)
  } finally {
    await db.query(`UPDATE settings SET value='true' WHERE key='tickets.assistant.enabled'`)
  }
})

test('POST /:id/ai-suggest — génération échoue → 502', { skip: SKIP }, async () => {
  _aiStub = async () => { throw new Error('Ollama down') }
  const admin = await adminAuth('oid-tk-ai-502')
  const id = (await createTicketAs(admin.token, { title: 'Y' })).json().id
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/ai-suggest`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 502)
  _aiStub = async () => 'Suggestion IA de test.'  // reset
})

test('POST /:id/ai-suggest — non-membre → 403', { skip: SKIP }, async () => {
  const owner = await adminAuth('oid-tk-ai-owner')
  const other = await userAuth('oid-tk-ai-outsider')
  const id = (await createTicketAs(owner.token, { title: 'Privé' })).json().id
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/ai-suggest`,
    headers: { authorization: `Bearer ${other.token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('DELETE message — supprime une ai_suggestion mais pas un message normal', { skip: SKIP }, async () => {
  _aiStub = async () => 'À supprimer'
  const admin = await adminAuth('oid-tk-ai-del')
  const id = (await createTicketAs(admin.token, { title: 'Del' })).json().id

  // Une suggestion → supprimable
  const sug = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/ai-suggest`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  const delSug = await fastify.inject({
    method: 'DELETE', url: `/api/tickets/${id}/messages/${sug.json().id}`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(delSug.statusCode, 204)

  // Un message normal (note interne) → protégé (404, pas supprimable)
  const note = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/messages`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { content: 'Vraie note' },
  })
  const delNote = await fastify.inject({
    method: 'DELETE', url: `/api/tickets/${id}/messages/${note.json().id}`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(delNote.statusCode, 404, 'un message non-IA ne doit pas être supprimable')
})

test('GET /:id — expose has_inbound_mail selon présence d\'email_thread_mapping inbound',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-has-inbound')
    const noMail = await createTicketAs(admin.token, { title: 'Sans mail' })
    const withMail = await createTicketAs(admin.token, { title: 'Avec mail' })
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, ticket_id)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
    `, [`<hi-${Math.random().toString(36).slice(2)}@x>`, withMail.json().id])

    const a = await fastify.inject({
      method: 'GET', url: `/api/tickets/${noMail.json().id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const b = await fastify.inject({
      method: 'GET', url: `/api/tickets/${withMail.json().id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(a.json().has_inbound_mail, false)
    assert.equal(b.json().has_inbound_mail, true)
  }
)

// ─── GET / (liste) — ACL non-admin vs admin ────────────────────────────────

test('GET / — non-admin ne voit QUE ses propres tickets', { skip: SKIP }, async () => {
  // Critique sécu : un non-admin lambda doit voir SES tickets (requester ou
  // assignee) et UNIQUEMENT ceux-là. Pas de leak des tickets des autres.
  const admin = await adminAuth('oid-tk-list-creator')
  const alice = await userAuth('oid-tk-alice', 'Alice')
  const bob   = await userAuth('oid-tk-bob', 'Bob')

  await createTicketAs(admin.token, { title: 'Ticket Alice', user_id: alice.user.entraId })
  await createTicketAs(admin.token, { title: 'Ticket Bob',   user_id: bob.user.entraId })
  await createTicketAs(admin.token, { title: 'Ticket sans owner' }) // admin only

  const res = await fastify.inject({
    method: 'GET', url: '/api/tickets/',
    headers: { authorization: `Bearer ${alice.token}` },
  })
  assert.equal(res.statusCode, 200)
  const titles = res.json().map(t => t.title)
  assert.ok(titles.includes('Ticket Alice'), 'Alice doit voir son ticket')
  assert.ok(!titles.includes('Ticket Bob'), 'Alice ne doit PAS voir le ticket de Bob')
  assert.ok(!titles.includes('Ticket sans owner'), 'Alice ne doit PAS voir le ticket sans owner')
})

test('GET / — admin voit tous les tickets + filtre status', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-list-admin')

  await createTicketAs(admin.token, { title: 'Bug visible 1' })
  await createTicketAs(admin.token, { title: 'Bug visible 2' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/tickets/?status=open',
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(rows.length >= 2, 'admin doit voir au moins ses créations open')
  // Filtre status=open respecté.
  for (const r of rows) assert.equal(r.status, 'open')
})

// ─── Archives : status='closed' opt-in ──────────────────────────────────────
// Le status 'closed' ne doit JAMAIS apparaître quand status est absent —
// sans ça, archiver un ticket ne ferait rien (il resterait dans "Tous").
// Et il doit apparaître quand on demande explicitement status=closed.

test('GET / — sans filtre status, exclut les tickets closed (archives opt-in)',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-closed-1')
    const create = await createTicketAs(admin.token, { title: 'À archiver' })
    const ticketId = create.json().id
    // Archive via PATCH.
    const patch = await fastify.inject({
      method: 'PATCH', url: `/api/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'closed' },
    })
    assert.equal(patch.statusCode, 200)

    // GET sans status : le ticket ne doit pas apparaître.
    const res = await fastify.inject({
      method: 'GET', url: '/api/tickets/',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const rows = res.json()
    assert.ok(!rows.some(r => r.id === ticketId),
      'ticket closed ne doit PAS apparaître dans GET sans filtre status')
  }
)

test('GET /?status=closed — retourne uniquement les archives',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-closed-2')
    const create = await createTicketAs(admin.token, { title: 'Archive me' })
    const closedId = create.json().id
    await fastify.inject({
      method: 'PATCH', url: `/api/tickets/${closedId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'closed' },
    })

    // Créer aussi un ticket OPEN pour vérifier qu'il n'apparaît pas.
    const open = await createTicketAs(admin.token, { title: 'Pas archivé' })

    const res = await fastify.inject({
      method: 'GET', url: '/api/tickets/?status=closed',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const rows = res.json()
    assert.ok(rows.some(r => r.id === closedId), 'archive doit apparaître')
    assert.ok(!rows.some(r => r.id === open.json().id), 'open ne doit PAS être dans status=closed')
    for (const r of rows) assert.equal(r.status, 'closed')
  }
)

test('GET /?q=… — recherche matche aussi le nom/email d\'une personne concernée',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-tk-q-user', 'Q Admin')
    const alice = await userAuth('oid-tk-q-alice', 'Alice Wonderland')
    const carol = await userAuth('oid-tk-q-carol', 'Carol Smith')

    // Ticket 1 : Alice = requester
    const t1 = await createTicketAs(admin.token, {
      title: 'Sujet neutre A', user_id: alice.user.entraId,
    })
    // Ticket 2 : Carol = involved (ajouté via /users)
    const t2 = await createTicketAs(admin.token, { title: 'Sujet neutre B' })
    await fastify.inject({
      method: 'POST', url: `/api/tickets/${t2.json().id}/users`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { entra_id: carol.user.entraId },
    })
    // Ticket 3 : aucune des deux
    const t3 = await createTicketAs(admin.token, { title: 'Sujet neutre C' })

    // Recherche "wonder" → matche Alice (requester de t1)
    const r1 = await fastify.inject({
      method: 'GET', url: '/api/tickets/?q=wonder',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const ids1 = r1.json().map(r => r.id)
    assert.ok(ids1.includes(t1.json().id), 'ticket avec Alice requester remonté')
    assert.ok(!ids1.includes(t3.json().id), 'ticket sans Alice ignoré')

    // Recherche par email → matche Carol (involved de t2)
    const r2 = await fastify.inject({
      method: 'GET', url: `/api/tickets/?q=${encodeURIComponent('oid-tk-q-carol@x')}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const ids2 = r2.json().map(r => r.id)
    assert.ok(ids2.includes(t2.json().id), 'ticket avec Carol involved remonté par email')
  }
)

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — Multi-relations users/devices + merge
// ═══════════════════════════════════════════════════════════════════════════

// ─── Migration 060 backfill ─────────────────────────────────────────────────

test('Migration 060 : ticket existant avec user_id/device_id → row en ticket_users / ticket_devices',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-backfill', 'BF Admin')
    const alice = await userAuth('oid-m2m-alice', 'Alice')
    const device = await seedDevice(db, { hostname: 'PC-BF' })
    const created = await createTicketAs(admin.token, {
      title: 'BF', user_id: alice.user.entraId, device_id: device.id,
    })
    const ticketId = created.json().id

    const { rows: u } = await db.query(
      `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1`, [ticketId]
    )
    assert.equal(u.length, 1)
    assert.equal(u[0].user_entra_id, alice.user.entraId)
    assert.equal(u[0].role, 'requester')

    const { rows: d } = await db.query(
      `SELECT device_id FROM ticket_devices WHERE ticket_id = $1`, [ticketId]
    )
    assert.equal(d.length, 1)
    assert.equal(d[0].device_id, device.id)
  }
)

// ─── GET /:id expose related_users + related_devices ────────────────────────

test('GET /:id — retourne related_users[] et related_devices[] (incluant requester)',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-get-related', 'GR Admin')
    const alice = await userAuth('oid-m2m-get-alice', 'Alice')
    const device = await seedDevice(db, { hostname: 'PC-GR' })
    const created = await createTicketAs(admin.token, {
      title: 'GR', user_id: alice.user.entraId, device_id: device.id,
    })
    const res = await fastify.inject({
      method: 'GET', url: `/api/tickets/${created.json().id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const tk = res.json()
    assert.ok(Array.isArray(tk.related_users))
    assert.ok(Array.isArray(tk.related_devices))
    assert.equal(tk.related_users.length, 1)
    assert.equal(tk.related_users[0].entra_id, alice.user.entraId)
    assert.equal(tk.related_users[0].role, 'requester')
    assert.equal(tk.related_users[0].display_name, 'Alice')
    assert.equal(tk.related_devices.length, 1)
    assert.equal(tk.related_devices[0].id, device.id)
    assert.equal(tk.related_devices[0].hostname, 'PC-GR')
  }
)

// ─── POST /:id/users + DELETE ────────────────────────────────────────────────

test('POST /:id/users — ajoute un involved (admin) + retourne 201',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-postusr', 'PU Admin')
    const bob = await userAuth('oid-m2m-bob', 'Bob')
    const created = await createTicketAs(admin.token, { title: 'PU' })

    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${created.json().id}/users`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { entra_id: bob.user.entraId },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().role, 'involved')

    // Vérifie via GET
    const det = await fastify.inject({
      method: 'GET', url: `/api/tickets/${created.json().id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const users = det.json().related_users
    assert.ok(users.some(u => u.entra_id === bob.user.entraId && u.role === 'involved'))
  }
)

test('POST /:id/users — role=requester remplace l\'ancien requester + sync tickets.user_id',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-changereq', 'CR Admin')
    const alice = await userAuth('oid-m2m-cr-alice', 'Alice')
    const bob = await userAuth('oid-m2m-cr-bob', 'Bob')
    const created = await createTicketAs(admin.token, { title: 'CR', user_id: alice.user.entraId })

    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${created.json().id}/users`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { entra_id: bob.user.entraId, role: 'requester' },
    })
    assert.equal(res.statusCode, 201)

    const { rows } = await db.query(
      `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1 ORDER BY role`,
      [created.json().id]
    )
    assert.equal(rows.length, 1, 'un seul user après remplacement requester')
    assert.equal(rows[0].user_entra_id, bob.user.entraId)
    assert.equal(rows[0].role, 'requester')

    const { rows: t } = await db.query(`SELECT user_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].user_id, bob.user.entraId, 'tickets.user_id sync sur nouveau requester')
  }
)

test('POST /:id/users — non-admin → 403', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-usr-acl-adm')
  const other = await userAuth('oid-m2m-usr-acl-usr')
  const bob = await userAuth('oid-m2m-usr-acl-bob')
  const created = await createTicketAs(admin.token, { title: 'ACL' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/users`,
    headers: { authorization: `Bearer ${other.token}` },
    payload: { entra_id: bob.user.entraId },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /:id/users — role inconnu → 400', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-usr-badrole')
  const bob = await userAuth('oid-m2m-usr-badrole-bob')
  const created = await createTicketAs(admin.token, { title: 'BR' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/users`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { entra_id: bob.user.entraId, role: 'spectator' },
  })
  assert.equal(res.statusCode, 400)
})

test('POST /:id/users — user introuvable → 404', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-usr-ghost')
  const created = await createTicketAs(admin.token, { title: 'G' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${created.json().id}/users`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { entra_id: 'oid-inexistant' },
  })
  assert.equal(res.statusCode, 404)
})

test('DELETE /:id/users/:entraId — retire le requester → tickets.user_id devient NULL',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-delreq', 'DR Admin')
    const alice = await userAuth('oid-m2m-dr-alice', 'Alice')
    const created = await createTicketAs(admin.token, { title: 'DR', user_id: alice.user.entraId })
    const res = await fastify.inject({
      method: 'DELETE', url: `/api/tickets/${created.json().id}/users/${alice.user.entraId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.statusCode, 204)
    const { rows: t } = await db.query(`SELECT user_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].user_id, null)
    const { rows: u } = await db.query(`SELECT user_entra_id FROM ticket_users WHERE ticket_id = $1`, [created.json().id])
    assert.equal(u.length, 0)
  }
)

test('DELETE /:id/users/:entraId — lien inexistant → 404', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-del404')
  const created = await createTicketAs(admin.token, { title: 'D4' })
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/tickets/${created.json().id}/users/oid-jamais-vu`,
    headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(res.statusCode, 404)
})

// ─── POST /:id/devices + DELETE ─────────────────────────────────────────────

test('POST /:id/devices — premier device → set tickets.device_id (primary)',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-dev-first')
    const created = await createTicketAs(admin.token, { title: 'DF' })
    const device = await seedDevice(db, { hostname: 'PC-DF' })
    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${created.json().id}/devices`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { device_id: device.id },
    })
    assert.equal(res.statusCode, 201)
    const { rows: t } = await db.query(`SELECT device_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].device_id, device.id, 'primary set sur 1er device')
  }
)

test('POST /:id/devices — 2e device → primary inchangé, ticket_devices.length=2',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-dev-second')
    const d1 = await seedDevice(db, { hostname: 'PC-D1' })
    const d2 = await seedDevice(db, { hostname: 'PC-D2' })
    const created = await createTicketAs(admin.token, { title: 'DS', device_id: d1.id })

    await fastify.inject({
      method: 'POST', url: `/api/tickets/${created.json().id}/devices`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { device_id: d2.id },
    })
    const { rows: t } = await db.query(`SELECT device_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].device_id, d1.id, 'primary reste sur le 1er')
    const { rows: tds } = await db.query(`SELECT device_id FROM ticket_devices WHERE ticket_id = $1`, [created.json().id])
    assert.equal(tds.length, 2)
  }
)

test('DELETE /:id/devices/:deviceId — retire primary → fallback sur le plus ancien restant',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-dev-rm-primary')
    const d1 = await seedDevice(db, { hostname: 'PC-RM1' })
    const d2 = await seedDevice(db, { hostname: 'PC-RM2' })
    const created = await createTicketAs(admin.token, { title: 'RMP', device_id: d1.id })
    await fastify.inject({
      method: 'POST', url: `/api/tickets/${created.json().id}/devices`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { device_id: d2.id },
    })

    const res = await fastify.inject({
      method: 'DELETE', url: `/api/tickets/${created.json().id}/devices/${d1.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.statusCode, 204)
    const { rows: t } = await db.query(`SELECT device_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].device_id, d2.id, 'primary fallback sur d2')
  }
)

test('DELETE /:id/devices/:deviceId — retire le seul device → tickets.device_id NULL',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-dev-rm-only')
    const d = await seedDevice(db, { hostname: 'PC-RM-ONLY' })
    const created = await createTicketAs(admin.token, { title: 'RMO', device_id: d.id })
    const res = await fastify.inject({
      method: 'DELETE', url: `/api/tickets/${created.json().id}/devices/${d.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.statusCode, 204)
    const { rows: t } = await db.query(`SELECT device_id FROM tickets WHERE id = $1`, [created.json().id])
    assert.equal(t[0].device_id, null)
  }
)

// ─── POST /:id/merge ─────────────────────────────────────────────────────────

test('POST /:id/merge — happy : messages + users + devices fusionnés, source devient merged',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-merge-ok', 'Merge Admin')
    const alice = await userAuth('oid-m2m-merge-alice', 'Alice')
    const bob = await userAuth('oid-m2m-merge-bob', 'Bob')
    const d1 = await seedDevice(db, { hostname: 'PC-MA' })
    const d2 = await seedDevice(db, { hostname: 'PC-MB' })

    const src = await createTicketAs(admin.token, { title: 'Source', user_id: alice.user.entraId, device_id: d1.id })
    const tgt = await createTicketAs(admin.token, { title: 'Target', user_id: bob.user.entraId, device_id: d2.id })

    // Ajoute un message au source pour vérifier qu'il bouge
    await fastify.inject({
      method: 'POST', url: `/api/tickets/${src.json().id}/messages`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { content: 'Message du source' },
    })

    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${src.json().id}/merge`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { target_ticket_id: tgt.json().id },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().merged_into, tgt.json().id)

    // Source : status='merged' + merged_into pointe vers target
    const { rows: srcRows } = await db.query(
      `SELECT status, merged_into FROM tickets WHERE id = $1`, [src.json().id]
    )
    assert.equal(srcRows[0].status, 'merged')
    assert.equal(srcRows[0].merged_into, tgt.json().id)

    // Target : a hérité du message + d'Alice (en 'involved' car Bob requester déjà) + du device d1
    const { rows: msgs } = await db.query(
      `SELECT content, type FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [tgt.json().id]
    )
    assert.ok(msgs.some(m => m.content === 'Message du source'), 'message du source repointé')
    assert.ok(msgs.some(m => m.type === 'system' && /Fusion/.test(m.content)), 'note system "Fusion" présente')

    const { rows: users } = await db.query(
      `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1 ORDER BY role`, [tgt.json().id]
    )
    const roles = Object.fromEntries(users.map(u => [u.user_entra_id, u.role]))
    assert.equal(roles[bob.user.entraId], 'requester')
    assert.equal(roles[alice.user.entraId], 'involved', 'Alice (ex-requester du source) downgrade en involved')

    const { rows: devs } = await db.query(
      `SELECT device_id FROM ticket_devices WHERE ticket_id = $1`, [tgt.json().id]
    )
    const devIds = devs.map(r => r.device_id)
    assert.ok(devIds.includes(d1.id) && devIds.includes(d2.id), 'les 2 devices fusionnés')

    // Source vidé des M2M (ON DELETE CASCADE des FK + DELETE explicite dans le merge)
    const { rows: srcUsers } = await db.query(`SELECT user_entra_id FROM ticket_users WHERE ticket_id = $1`, [src.json().id])
    assert.equal(srcUsers.length, 0)
  }
)

test('POST /:id/merge — target n\'avait pas de requester → hérite du source comme requester',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-merge-noreq')
    const carol = await userAuth('oid-m2m-merge-carol', 'Carol')
    const src = await createTicketAs(admin.token, { title: 'S2', user_id: carol.user.entraId })
    const tgt = await createTicketAs(admin.token, { title: 'T2' }) // pas de user_id

    const res = await fastify.inject({
      method: 'POST', url: `/api/tickets/${src.json().id}/merge`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { target_ticket_id: tgt.json().id },
    })
    assert.equal(res.statusCode, 200)

    const { rows: users } = await db.query(
      `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1`, [tgt.json().id]
    )
    assert.equal(users.length, 1)
    assert.equal(users[0].user_entra_id, carol.user.entraId)
    assert.equal(users[0].role, 'requester')

    const { rows: t } = await db.query(`SELECT user_id FROM tickets WHERE id = $1`, [tgt.json().id])
    assert.equal(t[0].user_id, carol.user.entraId, 'tickets.user_id sync')
  }
)

test('POST /:id/merge — self-merge → 400', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-merge-self')
  const tk = await createTicketAs(admin.token, { title: 'SM' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${tk.json().id}/merge`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { target_ticket_id: tk.json().id },
  })
  assert.equal(res.statusCode, 400)
})

test('POST /:id/merge — source déjà merged → 409', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-merge-twice')
  const a = await createTicketAs(admin.token, { title: 'A' })
  const b = await createTicketAs(admin.token, { title: 'B' })
  const c = await createTicketAs(admin.token, { title: 'C' })

  // a → b
  await fastify.inject({
    method: 'POST', url: `/api/tickets/${a.json().id}/merge`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { target_ticket_id: b.json().id },
  })
  // a → c : refusé car a est déjà merged
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${a.json().id}/merge`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { target_ticket_id: c.json().id },
  })
  assert.equal(res.statusCode, 409)
})

test('POST /:id/merge — target déjà merged → 409', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-merge-tgt-merged')
  const a = await createTicketAs(admin.token, { title: 'A' })
  const b = await createTicketAs(admin.token, { title: 'B' })
  const c = await createTicketAs(admin.token, { title: 'C' })

  await fastify.inject({
    method: 'POST', url: `/api/tickets/${b.json().id}/merge`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { target_ticket_id: c.json().id },
  })
  // a → b : b est déjà merged dans c → refusé
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${a.json().id}/merge`,
    headers: { authorization: `Bearer ${admin.token}` },
    payload: { target_ticket_id: b.json().id },
  })
  assert.equal(res.statusCode, 409)
})

test('POST /:id/merge — non-admin → 403', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-m2m-merge-acl-adm')
  const other = await userAuth('oid-m2m-merge-acl-usr')
  const a = await createTicketAs(admin.token, { title: 'A' })
  const b = await createTicketAs(admin.token, { title: 'B' })
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${a.json().id}/merge`,
    headers: { authorization: `Bearer ${other.token}` },
    payload: { target_ticket_id: b.json().id },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /:id/merge — email_thread_mapping repointé vers target',
  { skip: SKIP }, async () => {
    const admin = await adminAuth('oid-m2m-merge-etm')
    const src = await createTicketAs(admin.token, { title: 'Src' })
    const tgt = await createTicketAs(admin.token, { title: 'Tgt' })

    const msgId = `<merge-etm-${Math.random().toString(36).slice(2)}@x>`
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, ticket_id)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
    `, [msgId, src.json().id])

    await fastify.inject({
      method: 'POST', url: `/api/tickets/${src.json().id}/merge`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { target_ticket_id: tgt.json().id },
    })

    const { rows } = await db.query(
      `SELECT ticket_id FROM email_thread_mapping WHERE internet_message_id = $1`, [msgId]
    )
    assert.equal(rows[0].ticket_id, tgt.json().id)
  }
)

// ─── ACL non-admin : champs réservés, types de messages, contenu interne ────
// Un non-admin (requester / assignee) ne réassigne pas, ne change pas le
// demandeur, ne rattache que SON poste, ne poste que des commentaires et ne
// voit jamais les notes internes ni les suggestions IA.

async function insertOwnedDevice(hostname, assignedUserId = null) {
  const { rows } = await db.query(
    'INSERT INTO devices (hostname, assigned_user_id) VALUES ($1, $2) RETURNING id',
    [hostname, assignedUserId]
  )
  return rows[0].id
}

test('POST / — non-admin : assignation, demandeur tiers, poste d\'autrui, tags → 403', { skip: SKIP }, async () => {
  const me    = await userAuth('oid-tk-acl-create-me', 'Requester Create')
  const other = await userAuth('oid-tk-acl-create-other', 'Other')
  const otherDevice = await insertOwnedDevice('PC-ACL-OTHER', other.user.entraId)
  const { rows: [tag] } = await db.query(`INSERT INTO tags (name) VALUES ('acl-tag') RETURNING id`)

  for (const extra of [
    { assigned_to_entra_id: me.user.entraId, assigned_to_name: 'Moi' },
    { user_id: other.user.entraId },
    { device_id: otherDevice },
    { tag_ids: [tag.id] },
  ]) {
    const res = await createTicketAs(me.token, { title: 'Tentative', ...extra })
    assert.equal(res.statusCode, 403, `attendu 403 pour ${JSON.stringify(extra)}`)
  }
  const { rows } = await db.query(`SELECT 1 FROM tickets WHERE created_by_entra_id = $1`, [me.user.entraId])
  assert.equal(rows.length, 0, 'aucun ticket créé')
})

test('POST / — non-admin : ticket pour soi avec son propre poste → 201', { skip: SKIP }, async () => {
  const me = await userAuth('oid-tk-acl-create-ok', 'Requester OK')
  const myDevice = await insertOwnedDevice('PC-ACL-MINE', me.user.entraId)
  const res = await createTicketAs(me.token, { title: 'Mon PC', user_id: me.user.entraId, device_id: myDevice })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().user_id, me.user.entraId)
  assert.equal(res.json().device_id, myDevice)
})

test('PATCH /:id — requester non-admin : assignation, demandeur, poste d\'autrui → 403 ; statut et son poste OK', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-acl-patch-admin')
  const me    = await userAuth('oid-tk-acl-patch-me', 'Requester Patch')
  const other = await userAuth('oid-tk-acl-patch-other', 'Other Patch')
  const otherDevice = await insertOwnedDevice('PC-ACL-P-OTHER', other.user.entraId)
  const myDevice    = await insertOwnedDevice('PC-ACL-P-MINE', me.user.entraId)
  const id = (await createTicketAs(admin.token, { title: 'Mon ticket', user_id: me.user.entraId })).json().id
  const patch = (payload) => fastify.inject({
    method: 'PATCH', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${me.token}` }, payload,
  })

  for (const payload of [
    { assigned_to_entra_id: me.user.entraId },
    { assigned_to_name: 'Moi' },
    { user_id: other.user.entraId },
    { device_id: otherDevice },
  ]) {
    assert.equal((await patch(payload)).statusCode, 403, `attendu 403 pour ${JSON.stringify(payload)}`)
  }
  const { rows: [tk] } = await db.query('SELECT user_id, assigned_to_entra_id, device_id FROM tickets WHERE id = $1', [id])
  assert.deepEqual(tk, { user_id: me.user.entraId, assigned_to_entra_id: null, device_id: null })

  assert.equal((await patch({ device_id: myDevice })).statusCode, 200)
  assert.equal((await patch({ status: 'resolved' })).statusCode, 200)
})

test('PATCH /:id — assignee non-admin (pas requester) : rattacher un poste → 403', { skip: SKIP }, async () => {
  const admin    = await adminAuth('oid-tk-acl-assignee-admin')
  const assignee = await userAuth('oid-tk-acl-assignee', 'Assignee NA')
  const myDevice = await insertOwnedDevice('PC-ACL-ASSIGNEE', assignee.user.entraId)
  const id = (await createTicketAs(admin.token, {
    title: 'Assigné', assigned_to_entra_id: assignee.user.entraId, assigned_to_name: 'Assignee NA',
  })).json().id
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${assignee.token}` }, payload: { device_id: myDevice },
  })
  assert.equal(res.statusCode, 403)
})

test('POST /:id/messages — requester non-admin : system / resolution / note interne → 403, défaut = comment', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-acl-msg-admin')
  const me    = await userAuth('oid-tk-acl-msg-me', 'Requester Msg')
  const id = (await createTicketAs(admin.token, { title: 'Fil', user_id: me.user.entraId })).json().id
  const post = (payload) => fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/messages`,
    headers: { authorization: `Bearer ${me.token}` }, payload,
  })

  for (const type of ['system', 'resolution', 'internal_note']) {
    assert.equal((await post({ content: 'x', type })).statusCode, 403, `type ${type}`)
  }
  const ok = await post({ content: 'Toujours en panne' })
  assert.equal(ok.statusCode, 201)
  assert.equal(ok.json().type, 'comment')

  const { rows } = await db.query('SELECT type FROM ticket_messages WHERE ticket_id = $1', [id])
  assert.deepEqual(rows.map(r => r.type), ['comment'])
})

test('GET /:id et GET /?q= — requester non-admin : ni notes internes ni suggestions IA', { skip: SKIP }, async () => {
  const admin = await adminAuth('oid-tk-acl-read-admin')
  const me    = await userAuth('oid-tk-acl-read-me', 'Requester Read')
  const id = (await createTicketAs(admin.token, { title: 'Lecture', user_id: me.user.entraId })).json().id
  await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content) VALUES
      ($1, 'comment',       'Tech', 'Réponse publique'),
      ($1, 'internal_note', 'Tech', 'NOTEINTERNE mot de passe wifi'),
      ($1, 'ai_suggestion', 'Assistant IA', 'SUGGESTIONIA brouillon'),
      ($1, 'system',        'Tech', 'Ticket pris en charge')
  `, [id])

  const det = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`, headers: { authorization: `Bearer ${me.token}` },
  })
  assert.equal(det.statusCode, 200)
  assert.deepEqual(det.json().messages.map(m => m.type).sort(), ['comment', 'system'])
  assert.doesNotMatch(det.body, /NOTEINTERNE|SUGGESTIONIA/)

  const adminDet = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`, headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.equal(adminDet.json().messages.length, 4, 'l\'admin voit tout le fil')

  for (const q of ['NOTEINTERNE', 'SUGGESTIONIA']) {
    const list = await fastify.inject({
      method: 'GET', url: `/api/tickets/?q=${q}`, headers: { authorization: `Bearer ${me.token}` },
    })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json(), [], `recherche ${q} ne doit pas matcher pour un non-admin`)
  }
  const adminList = await fastify.inject({
    method: 'GET', url: '/api/tickets/?q=NOTEINTERNE', headers: { authorization: `Bearer ${admin.token}` },
  })
  assert.ok(adminList.json().some(t => t.id === id), 'l\'admin cherche dans les notes internes')
})

test('ai-suggest et send-by-mail — requester non-admin → 403, rien d\'exposé', { skip: SKIP }, async () => {
  _aiStub = async () => 'SUGGESTION qui cite la note interne'
  const admin = await adminAuth('oid-tk-acl-ai-admin')
  const me    = await userAuth('oid-tk-acl-ai-me', 'Requester AI')
  const id = (await createTicketAs(admin.token, { title: 'IA', user_id: me.user.entraId })).json().id
  const { rows: [note] } = await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
    VALUES ($1, 'internal_note', 'Tech', 'note privée', now()) RETURNING id
  `, [id])
  await db.query(`
    INSERT INTO email_thread_mapping (internet_message_id, mailbox, direction, received_at, ticket_id)
    VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
  `, [`<acl-${id}@x>`, id])

  const ai = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/ai-suggest`, headers: { authorization: `Bearer ${me.token}` },
  })
  assert.equal(ai.statusCode, 403)
  assert.doesNotMatch(ai.body, /SUGGESTION/)

  const send = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/messages/${note.id}/send-by-mail`,
    headers: { authorization: `Bearer ${me.token}` },
  })
  assert.equal(send.statusCode, 403)

  const { rows } = await db.query('SELECT type FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [id])
  assert.deepEqual(rows.map(r => r.type), ['internal_note'], 'ni suggestion créée ni note convertie')
  _aiStub = async () => 'Suggestion IA de test.'
})
