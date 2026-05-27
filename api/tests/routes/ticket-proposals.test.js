// routes/ticket-proposals.js : liste, count, accept, reject.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedProposal } from '../fixtures/ticket-proposals.js'

import ticketProposalsRoute from '../../modules/tickets/routes/ticket-proposals.js'

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
      await f.register(ticketProposalsRoute, { prefix: '/api/ticket-proposals' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminAuth(entraId = 'oid-tp-admin', name = 'TP Admin') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

async function nonAdminAuth(entraId = 'oid-tp-user', name = 'TP User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}

// ─── ACL ─────────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/ticket-proposals/' })
  assert.equal(res.statusCode, 401)
})

test('GET / — non-admin → 403', { skip: SKIP }, async () => {
  const { token } = await nonAdminAuth('oid-tp-user-acl')
  const res = await fastify.inject({
    method: 'GET', url: '/api/ticket-proposals/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET /count — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/ticket-proposals/count' })
  assert.equal(res.statusCode, 401)
})

// ─── GET / — liste avec filtres ───────────────────────────────────────────────

test('GET / — retourne les proposals pending par défaut', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-list-pending')
  await seedProposal(db, { suggestedTitle: 'Prop pending list', status: 'pending' })
  await seedProposal(db, { suggestedTitle: 'Prop accepted list', status: 'accepted' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/ticket-proposals/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(Array.isArray(rows))
  // Tous les résultats sont pending
  for (const r of rows) assert.equal(r.status, 'pending')
})

test('GET /?status=all — retourne tous les statuts', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-list-all')
  await seedProposal(db, { suggestedTitle: 'Prop pending all', status: 'pending' })
  await seedProposal(db, { suggestedTitle: 'Prop rejected all', status: 'rejected' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/ticket-proposals/?status=all',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  const statuses = new Set(rows.map(r => r.status))
  // Avec status=all on doit voir au moins deux statuts différents
  assert.ok(statuses.size >= 2, 'status=all doit retourner plusieurs statuts')
})

// ─── GET /count ───────────────────────────────────────────────────────────────

test('GET /count — reflète le nombre de pending', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-count')

  // Récupérer le count actuel avant d'ajouter
  const before = await fastify.inject({
    method: 'GET', url: '/api/ticket-proposals/count',
    headers: { authorization: `Bearer ${token}` },
  })
  const pendingBefore = before.json().pending

  await seedProposal(db, { suggestedTitle: 'Count test 1', status: 'pending' })
  await seedProposal(db, { suggestedTitle: 'Count test 2', status: 'pending' })
  await seedProposal(db, { suggestedTitle: 'Count ignored', status: 'accepted' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/ticket-proposals/count',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().pending, pendingBefore + 2, 'count doit augmenter de 2')
})

// ─── POST /:id/accept ─────────────────────────────────────────────────────────

test('POST /:id/accept — crée un ticket + proposal devient accepted', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept')
  const device = await seedDevice(db, { hostname: 'PC-ACCEPT' })
  const prop = await seedProposal(db, {
    suggestedTitle: 'Prop à accepter',
    suggestedPriority: 'high',
    suggestedDeviceId: device.id,
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.ticket, 'doit retourner le ticket créé')
  assert.equal(body.proposal_id, prop.id)

  // Champs mappés du ticket
  const tk = body.ticket
  assert.equal(tk.title, 'Prop à accepter')
  assert.equal(tk.priority, 'high')
  assert.equal(tk.device_id, device.id)
  assert.equal(tk.is_auto, true)

  // Proposal en DB : status accepted + ticket_id positionné
  const { rows } = await db.query(
    'SELECT status, ticket_id FROM ticket_proposals WHERE id = $1', [prop.id]
  )
  assert.equal(rows[0].status, 'accepted')
  assert.equal(rows[0].ticket_id, tk.id)
})

test('POST /:id/accept — surcharge title/description/priority fonctionne', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-override')
  const prop = await seedProposal(db, { suggestedTitle: 'Titre original', suggestedPriority: 'low' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Titre surchargé', priority: 'critical', description: 'Desc ajoutée' },
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket
  assert.equal(tk.title, 'Titre surchargé')
  assert.equal(tk.priority, 'critical')
  assert.equal(tk.description, 'Desc ajoutée')
})

test('POST /:id/accept — source=email avec bodyText → description courte + premier message', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-email-body')
  const prop = await seedProposal(db, {
    source: 'email',
    suggestedTitle: 'Mon imprimante ne marche pas',
    suggestedDescription: 'De: Alice <alice@ex.fr>\nSujet: Mon imprimante ne marche pas\n\nBonjour,\n\nL\'imprimante du bureau ne répond plus.\n\nAlice',
    sourcePayload: {
      from: 'alice@ex.fr',
      fromName: 'Alice Dupont',
      receivedAt: '2026-02-05T14:30:00.000Z',
      bodyText: "Bonjour,\n\nL'imprimante du bureau ne répond plus.\n\nAlice",
    },
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket

  // Description = ligne courte "Mail de X reçu le Y"
  assert.match(tk.description, /^Mail de Alice Dupont reçu le /, 'description courte attendue')
  assert.ok(!tk.description.includes('imprimante'), 'body NE doit PAS être dans la description')

  // Le body est dans ticket_messages, pas dans description
  const { rows: msgs } = await db.query(
    `SELECT type, author, content, email_sent_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [tk.id]
  )
  assert.equal(msgs.length, 1, 'un seul message attendu (pas de replies)')
  assert.equal(msgs[0].type, 'comment')
  assert.equal(msgs[0].author, 'Alice Dupont')
  assert.match(msgs[0].content, /imprimante du bureau/)
  assert.ok(msgs[0].email_sent_at, 'email_sent_at doit être set (déjà reçu, pas à renvoyer)')
})

test('POST /:id/accept — source=email avec replies → premier + N messages chronologiques', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-email-replies')
  const prop = await seedProposal(db, {
    source: 'email',
    suggestedTitle: 'Problème VPN',
    sourcePayload: {
      from: 'bob@ex.fr',
      fromName: 'Bob Martin',
      receivedAt: '2026-02-05T09:00:00.000Z',
      bodyText: 'VPN ne fonctionne plus depuis ce matin.',
      replies: [
        {
          from: 'bob@ex.fr',
          fromName: 'Bob Martin',
          receivedAt: '2026-02-05T09:30:00.000Z',
          bodyText: 'Pour info j\'ai redémarré le poste, ça ne change rien.',
        },
        {
          from: 'bob@ex.fr',
          fromName: 'Bob Martin',
          receivedAt: '2026-02-05T10:15:00.000Z',
          bodyText: 'En fait ça marche depuis que je suis sur le wifi maison ??',
        },
      ],
    },
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket

  const { rows: msgs } = await db.query(
    `SELECT author, content, created_at, email_sent_at FROM ticket_messages
     WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [tk.id]
  )
  assert.equal(msgs.length, 3, '1 initial + 2 replies')
  assert.match(msgs[0].content, /VPN ne fonctionne plus/)
  assert.match(msgs[1].content, /redémarré le poste/)
  assert.match(msgs[2].content, /wifi maison/)
  // Tous marqués déjà envoyés (mails entrants)
  for (const m of msgs) assert.ok(m.email_sent_at, 'tous les messages ont email_sent_at')
  // created_at suit la chronologie réelle des mails (pas l'ordre d'INSERT)
  assert.ok(new Date(msgs[0].created_at) < new Date(msgs[1].created_at))
  assert.ok(new Date(msgs[1].created_at) < new Date(msgs[2].created_at))
})

test('POST /:id/accept — source=email legacy sans bodyText → fallback strip "De:/Sujet:"', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-email-legacy')
  // Proposal créée AVANT la Phase 1a : suggested_description contient le
  // format "De: ... / Sujet: ... / <body>", pas de bodyText dans payload.
  const prop = await seedProposal(db, {
    source: 'email',
    suggestedTitle: 'Demande accès',
    suggestedDescription: 'De: Carole <carole@ex.fr>\nSujet: Demande accès\n\nJ\'ai besoin d\'accéder au partage RH.',
    sourcePayload: {
      from: 'carole@ex.fr',
      fromName: 'Carole',
      receivedAt: '2026-02-04T08:00:00.000Z',
    },
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket
  assert.match(tk.description, /^Mail de Carole reçu le /)

  const { rows: msgs } = await db.query(
    `SELECT content FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].content, "J'ai besoin d'accéder au partage RH.",
    'le préfixe "De:/Sujet:" doit être strippé')
})

test('POST /:id/accept — source=email + override description force la description fournie', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-email-override')
  const prop = await seedProposal(db, {
    source: 'email',
    suggestedTitle: 'X',
    sourcePayload: { fromName: 'Dan', receivedAt: '2026-02-05T10:00:00Z', bodyText: 'body de Dan' },
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: { description: 'Description manuelle' },
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket
  assert.equal(tk.description, 'Description manuelle', 'override doit gagner sur le format auto')

  // Le premier message du mail n'est PAS créé dans ce cas (l'admin a décidé
  // de réécrire la description et garde la main).
  const { rows: msgs } = await db.query(
    `SELECT id FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 0, 'override description = pas de premier message auto')
})

test('POST /:id/accept — source=manual → comportement inchangé (description = suggested_description)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-manual')
  const prop = await seedProposal(db, {
    source: 'manual',
    suggestedTitle: 'Manuel',
    suggestedDescription: 'Ma description manuelle',
  })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 201)
  const tk = res.json().ticket
  assert.equal(tk.description, 'Ma description manuelle')

  const { rows: msgs } = await db.query(
    `SELECT id FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 0, 'pas de message auto pour source!=email')
})

test('POST /:id/accept — proposal inexistante → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-404')
  const res = await fastify.inject({
    method: 'POST', url: '/api/ticket-proposals/00000000-0000-0000-0000-000000000000/accept',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 404)
})

test('POST /:id/accept — idempotence : 2ème accept → 409', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-accept-idem')
  const prop = await seedProposal(db, { suggestedTitle: 'Double accept' })

  // Premier accept
  const first = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(first.statusCode, 201)

  // Deuxième accept
  const second = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(second.statusCode, 409)
  assert.ok(second.json().error, 'doit retourner un message d\'erreur')
})

// ─── POST /:id/reject ─────────────────────────────────────────────────────────

test('POST /:id/reject — pending → rejected avec reason', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-reject')
  const prop = await seedProposal(db, { suggestedTitle: 'Prop à rejeter' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/reject`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: 'Doublon avec ticket existant' },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.status, 'rejected')
  assert.equal(body.rejected_reason, 'Doublon avec ticket existant')
  assert.ok(body.reviewed_at, 'reviewed_at doit être set')
})

test('POST /:id/reject — sans reason → rejected quand même', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-reject-noreason')
  const prop = await seedProposal(db, { suggestedTitle: 'Prop sans reason' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/reject`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'rejected')
  assert.equal(res.json().rejected_reason, null)
})

test('POST /:id/reject — déjà traitée → 409', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-reject-idem')
  const prop = await seedProposal(db, { suggestedTitle: 'Déjà rejetée', status: 'rejected' })

  const res = await fastify.inject({
    method: 'POST', url: `/api/ticket-proposals/${prop.id}/reject`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: 'encore' },
  })
  assert.equal(res.statusCode, 409)
})

test('POST /:id/reject — proposal inexistante → 409', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-tp-reject-404')
  const res = await fastify.inject({
    method: 'POST', url: '/api/ticket-proposals/00000000-0000-0000-0000-000000000000/reject',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  // L'implémentation utilise WHERE id=? AND status='pending' → 0 rows → 409
  assert.equal(res.statusCode, 409)
})
