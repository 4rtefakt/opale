// modules/hardware/routes/requests.js : demandes de matériel et commandes.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import sensible from '@fastify/sensible'

import hardwareRequestsRoute from '../../modules/hardware/routes/requests.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const BASE = '/api/hardware-requests'

let db, release, fastify, jwt, token, headers

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()
  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(sensible)
      await f.register(hardwareRequestsRoute, { prefix: BASE })
    },
  })
  const admin = await seedAdmin(db, { entraId: 'oid-hw-admin', displayName: 'Admin Matériel', email: 'hw-admin@x' })
  token = await jwt.sign({ oid: admin.entraId, name: admin.displayName, preferred_username: admin.email })
  headers = { authorization: `Bearer ${token}` }
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

const create = (payload) => fastify.inject({ method: 'POST', url: `${BASE}/`, headers, payload })

test('hardware — sans JWT → 401, non-admin → 403 sur lecture et écriture', { skip: SKIP }, async () => {
  assert.equal((await fastify.inject({ method: 'GET', url: `${BASE}/` })).statusCode, 401)
  const u = await seedNonAdmin(db, { entraId: 'oid-hw-na', email: 'hw-na@x' })
  const na = { authorization: `Bearer ${await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })}` }
  assert.equal((await fastify.inject({ method: 'GET', url: `${BASE}/`, headers: na })).statusCode, 403)
  assert.equal((await fastify.inject({ method: 'POST', url: `${BASE}/`, headers: na, payload: { title: 'X' } })).statusCode, 403)
  const { rows } = await db.query(`SELECT 1 FROM hardware_requests WHERE title = 'X'`)
  assert.equal(rows.length, 0)
})

test('POST — création : demandeur annuaire, ticket lié, historique « created »', { skip: SKIP }, async () => {
  const requester = await seedNonAdmin(db, { entraId: 'oid-hw-req', displayName: 'Lucie Test', email: 'lucie@x' })
  const { rows: [tk] } = await db.query(`INSERT INTO tickets (title) VALUES ('Casque') RETURNING id`)
  const res = await create({
    title: 'Casque audio', category: 'Accessoire', status: 'to_order',
    requester_entra_id: requester.entraId, ticket_id: tk.id, requested_at: '2026-09-15',
  })
  assert.equal(res.statusCode, 201)
  const r = res.json()
  assert.equal(r.requester_name, 'Lucie Test')
  assert.equal(r.ticket_title, 'Casque')
  assert.equal(r.requested_at, '2026-09-15', 'date renvoyée sans décalage de fuseau')
  assert.equal(r.created_by_name, 'Admin Matériel')

  const detail = (await fastify.inject({ method: 'GET', url: `${BASE}/${r.id}`, headers })).json()
  assert.equal(detail.events.length, 1)
  assert.equal(detail.events[0].kind, 'created')
  assert.equal(detail.events[0].to_status, 'to_order')
})

test('POST — validation : titre manquant, statut inconnu, références introuvables → 400', { skip: SKIP }, async () => {
  assert.equal((await create({ category: 'X' })).statusCode, 400)
  assert.equal((await create({ title: 'A', status: 'lost' })).statusCode, 400)
  assert.equal((await create({ title: 'A', amount_eur: -1 })).statusCode, 400)
  assert.equal((await create({ title: 'A', requested_at: '15/09/2026' })).statusCode, 400)
  assert.equal((await create({ title: 'A', requester_entra_id: 'oid-inconnu' })).statusCode, 400)
  assert.equal((await create({ title: 'A', ticket_id: '00000000-0000-0000-0000-000000000000' })).statusCode, 400)
  // Champ inconnu : retiré par Ajv (removeAdditional, réglage par défaut de
  // Fastify), jamais écrit.
  const extra = await create({ title: 'Champ inconnu', pirate: true })
  assert.equal(extra.statusCode, 201)
  assert.equal(extra.json().pirate, undefined)
  const { rows } = await db.query(`SELECT 1 FROM hardware_requests WHERE title = 'A'`)
  assert.equal(rows.length, 0, 'aucune demande invalide créée')
})

test('PATCH — changement de statut : événement, closed_at posé puis retiré', { skip: SKIP }, async () => {
  const r = (await create({ title: 'Disques USB-C', status: 'quote' })).json()

  const done = await fastify.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers,
    payload: { status: 'done', supplier: 'LDLC', amount_eur: 129.9 } })
  assert.equal(done.statusCode, 200)
  assert.equal(done.json().status, 'done')
  assert.ok(done.json().closed_at)
  assert.equal(Number(done.json().amount_eur), 129.9)

  const reopened = await fastify.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers, payload: { status: 'ordered' } })
  assert.equal(reopened.json().closed_at, null)

  // Même statut : pas d'événement supplémentaire.
  await fastify.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers, payload: { status: 'ordered', notes: 'x' } })
  const { rows } = await db.query(
    `SELECT kind, from_status, to_status FROM hardware_request_events WHERE request_id = $1 AND kind = 'status' ORDER BY created_at`, [r.id])
  assert.deepEqual(rows, [
    { kind: 'status', from_status: 'quote', to_status: 'done' },
    { kind: 'status', from_status: 'done', to_status: 'ordered' },
  ])

  // Champ vidé avec null.
  const cleared = await fastify.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers, payload: { supplier: null } })
  assert.equal(cleared.json().supplier, null)
})

test('PATCH — corps vide → 400, demande inconnue → 404', { skip: SKIP }, async () => {
  const r = (await create({ title: 'Écran' })).json()
  assert.equal((await fastify.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers, payload: {} })).statusCode, 400)
  const missing = await fastify.inject({ method: 'PATCH', url: `${BASE}/00000000-0000-0000-0000-000000000000`, headers,
    payload: { title: 'Y' } })
  assert.equal(missing.statusCode, 404)
})

test('POST /:id/reminders — compteur, date de la dernière relance, note', { skip: SKIP }, async () => {
  const r = (await create({ title: 'Station d\'accueil' })).json()
  await fastify.inject({ method: 'POST', url: `${BASE}/${r.id}/reminders`, headers, payload: { date: '2026-09-25' } })
  const res = await fastify.inject({ method: 'POST', url: `${BASE}/${r.id}/reminders`, headers,
    payload: { date: '2026-09-20', note: 'par Teams' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().reminder_count, 2)
  assert.equal(res.json().last_reminder_at, '2026-09-25', 'une relance plus ancienne ne recule pas la date')
  const { rows } = await db.query(`SELECT note FROM hardware_request_events WHERE request_id = $1 AND kind = 'reminder'`, [r.id])
  assert.equal(rows.length, 2)
})

test('POST /:id/notes — note ajoutée à l\'historique', { skip: SKIP }, async () => {
  const r = (await create({ title: 'Clavier' })).json()
  const res = await fastify.inject({ method: 'POST', url: `${BASE}/${r.id}/notes`, headers, payload: { note: 'Reçu le 25/08' } })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().note, 'Reçu le 25/08')
  assert.equal((await fastify.inject({ method: 'POST', url: `${BASE}/${r.id}/notes`, headers, payload: { note: '' } })).statusCode, 400)
})

test('GET — filtres state et q, demandes closes en dernier', { skip: SKIP }, async () => {
  await create({ title: 'Tablette terrain zz', status: 'quote' })
  await create({ title: 'Tablette livrée zz', status: 'done' })
  const open = (await fastify.inject({ method: 'GET', url: `${BASE}/?state=open&q=zz`, headers })).json()
  assert.deepEqual(open.map(r => r.title), ['Tablette terrain zz'])
  const closed = (await fastify.inject({ method: 'GET', url: `${BASE}/?state=closed&q=zz`, headers })).json()
  assert.deepEqual(closed.map(r => r.title), ['Tablette livrée zz'])
  const all = (await fastify.inject({ method: 'GET', url: `${BASE}/?q=zz`, headers })).json()
  assert.deepEqual(all.map(r => r.title), ['Tablette terrain zz', 'Tablette livrée zz'])
})

test('DELETE — supprime la demande et son historique, trace d\'audit', { skip: SKIP }, async () => {
  const r = (await create({ title: 'Doublon' })).json()
  const res = await fastify.inject({ method: 'DELETE', url: `${BASE}/${r.id}`, headers })
  assert.equal(res.statusCode, 204)
  assert.equal((await fastify.inject({ method: 'GET', url: `${BASE}/${r.id}`, headers })).statusCode, 404)
  const { rows } = await db.query(`SELECT 1 FROM hardware_request_events WHERE request_id = $1`, [r.id])
  assert.equal(rows.length, 0)
  const { rows: audit } = await db.query(`SELECT 1 FROM audit_logs WHERE action = 'hardware_request_deleted' AND target = $1`, [r.id])
  assert.equal(audit.length, 1)
})
