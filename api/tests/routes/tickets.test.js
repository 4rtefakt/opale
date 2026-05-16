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

  const { rows } = await db.query('SELECT updated_at FROM tickets WHERE id = $1', [id])
  assert.ok(new Date(rows[0].updated_at).getTime() > updatedBefore,
    'updated_at doit être bumped après ajout message')
})

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
