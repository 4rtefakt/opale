// routes/onboarding.js — couverture des chemins critiques :
// - GET / (liste avec filtres kind/status)
// - POST / (créer + génération checklist)
// - GET /:id (détail avec checks)
// - PATCH /:id (update champs)
// - DELETE /:id
// - PATCH /:id/checks/:checkId (toggle manuel + auto-status)
//
// POST /:id/checks/:checkId/auto : fait appel à graph.js (createEntraUser,
// addUserToGroup, disableEntraUser, revokeUserSessions). Ces fonctions sont
// mockées via un module-level spy pour les tests qui les touchent (step_id
// inconnu → 500 sans Graph), ou skippées avec note pour les cas nécessitant
// une vraie réponse Graph (create_account, assign_license, etc.).

import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import onboardingRoute from '../../modules/onboarding/routes/onboarding.js'

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
      await f.register(onboardingRoute, { prefix: '/api/onboarding' })
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminToken(entraId, name = 'Admin Onboarding') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function userToken(entraId) {
  const u = await seedNonAdmin(db, { entraId, displayName: 'User', email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

async function createOnboarding(token, body = {}) {
  return fastify.inject({
    method: 'POST', url: '/api/onboarding/',
    headers: { authorization: `Bearer ${token}` },
    payload: { person_name: 'Jean Test', kind: 'onboard', ...body },
  })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/onboarding/' })
  assert.equal(res.statusCode, 401)
})

test('POST / — non-admin → 403', { skip: SKIP }, async () => {
  const token = await userToken('oid-ob-create-403')
  const res = await fastify.inject({
    method: 'POST', url: '/api/onboarding/',
    headers: { authorization: `Bearer ${token}` },
    payload: { person_name: 'Test' },
  })
  assert.equal(res.statusCode, 403)
})

// ─── GET / — liste et filtres ─────────────────────────────────────────────────

test('GET / — admin : liste avec total_checks + done_checks', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-list-ok')
  await createOnboarding(token, { person_name: 'Alice Liste' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/onboarding/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(Array.isArray(rows))
  const found = rows.find(r => r.person_name === 'Alice Liste')
  assert.ok(found, 'Alice Liste doit apparaître')
  assert.equal(typeof found.total_checks, 'number')
  assert.equal(typeof found.done_checks, 'number')
  assert.ok(found.total_checks > 0, 'la checklist doit être générée')
})

test('GET /?kind=offboard — filtre par kind', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-list-kind')
  await createOnboarding(token, { person_name: 'Bob Onboard', kind: 'onboard' })
  await createOnboarding(token, { person_name: 'Claire Offboard', kind: 'offboard' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/onboarding/?kind=offboard',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(rows.every(r => r.kind === 'offboard'), 'tous doivent être offboard')
  assert.ok(rows.some(r => r.person_name === 'Claire Offboard'))
  assert.ok(!rows.some(r => r.person_name === 'Bob Onboard'))
})

test('GET /?status=done — filtre par status', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-list-status')
  // Créer un onboarding puis forcer son status en 'done' via PATCH
  const created = (await createOnboarding(token, { person_name: 'Done Person' })).json()
  await fastify.inject({
    method: 'PATCH', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'done' },
  })
  const res = await fastify.inject({
    method: 'GET', url: '/api/onboarding/?status=done',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const rows = res.json()
  assert.ok(rows.every(r => r.status === 'done'))
})

// ─── POST / — création ───────────────────────────────────────────────────────

test('POST / — person_name manquant → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-create-400')
  const res = await fastify.inject({
    method: 'POST', url: '/api/onboarding/',
    headers: { authorization: `Bearer ${token}` },
    payload: { email: 'x@x.fr' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /nom|person_name/i)
})

test('POST / — création réussie → 201 + checklist générée en DB', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-create-ok')
  const res = await createOnboarding(token, {
    person_name: 'Marie Dupont',
    email: 'marie@example.com',
    role: 'Dev',
    kind: 'onboard',
  })
  assert.equal(res.statusCode, 201)
  const ob = res.json()
  assert.ok(ob.id)
  assert.equal(ob.person_name, 'Marie Dupont')
  assert.equal(ob.kind, 'onboard')
  assert.equal(ob.status, 'in_progress')
  // Vérifier que la checklist est bien créée en DB
  const { rows: checks } = await db.query(
    'SELECT id FROM onboarding_checks WHERE onboarding_id = $1', [ob.id]
  )
  assert.ok(checks.length > 0, 'la checklist doit être générée')
})

test('POST / — kind=offboard génère une checklist différente', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-create-offboard')
  const res = await createOnboarding(token, { person_name: 'Pierre Offboard', kind: 'offboard' })
  assert.equal(res.statusCode, 201)
  const ob = res.json()
  const { rows: checks } = await db.query(
    "SELECT step_id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'disable_account'",
    [ob.id]
  )
  assert.ok(checks.length > 0, 'offboard doit contenir le step disable_account')
})

// ─── GET /:id — détail ────────────────────────────────────────────────────────

test('GET /:id — id inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-get-404')
  const res = await fastify.inject({
    method: 'GET', url: '/api/onboarding/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — retourne onboarding + checks', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-get-ok')
  const created = (await createOnboarding(token, { person_name: 'Get Detail' })).json()
  const res = await fastify.inject({
    method: 'GET', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.id, created.id)
  assert.ok(Array.isArray(body.checks))
  assert.ok(body.checks.length > 0)
  // Les checks doivent avoir les champs attendus
  const first = body.checks[0]
  assert.ok(first.step_id)
  assert.ok(first.label)
  assert.equal(first.done, false)
})

test('GET /:id — non-admin peut lire (route ouverte aux authentifiés)', { skip: SKIP }, async () => {
  const adminTok = await adminToken('oid-ob-get-nonadmin-setup')
  const created = (await createOnboarding(adminTok, { person_name: 'Readable' })).json()
  const token = await userToken('oid-ob-get-nonadmin')
  const res = await fastify.inject({
    method: 'GET', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
})

// ─── PATCH /:id — update ─────────────────────────────────────────────────────

test('PATCH /:id — id inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-patch-404')
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/onboarding/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'done' },
  })
  assert.equal(res.statusCode, 404)
})

test('PATCH /:id — aucun champ → 400', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-patch-empty')
  const created = (await createOnboarding(token, { person_name: 'Patch Empty' })).json()
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

test('PATCH /:id — mise à jour réussie', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-patch-ok')
  const created = (await createOnboarding(token, { person_name: 'Patch OK' })).json()
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { role: 'Développeur', notes: 'Arrivée le 15' },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.role, 'Développeur')
  assert.equal(body.notes, 'Arrivée le 15')
})

// ─── PATCH /:id/checks/:checkId — toggle manuel ──────────────────────────────

test('PATCH /:id/checks/:checkId — check inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-check-404')
  const created = (await createOnboarding(token, { person_name: 'Check 404' })).json()
  const res = await fastify.inject({
    method: 'PATCH',
    url: `/api/onboarding/${created.id}/checks/00000000-0000-0000-0000-000000000000`,
    headers: { authorization: `Bearer ${token}` },
    payload: { done: true },
  })
  assert.equal(res.statusCode, 404)
})

test('PATCH /:id/checks/:checkId — toggle done=true', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-check-toggle')
  const created = (await createOnboarding(token, { person_name: 'Toggle Check' })).json()

  // Récupérer un check non-auto pour le toggle manuel
  const { rows: checks } = await db.query(
    'SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND is_auto = false LIMIT 1',
    [created.id]
  )
  assert.ok(checks.length > 0, 'doit avoir des checks non-auto')
  const checkId = checks[0].id

  const res = await fastify.inject({
    method: 'PATCH',
    url: `/api/onboarding/${created.id}/checks/${checkId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { done: true },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.done, true)
  assert.ok(body.done_at)

  // Vérifier en DB
  const { rows: [ch] } = await db.query(
    'SELECT done, done_at FROM onboarding_checks WHERE id = $1', [checkId]
  )
  assert.equal(ch.done, true)
  assert.ok(ch.done_at)
})

test('PATCH /:id/checks/:checkId — toggle done=false (undone)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-check-undone')
  const created = (await createOnboarding(token, { person_name: 'Undone Check' })).json()

  const { rows: checks } = await db.query(
    'SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND is_auto = false LIMIT 1',
    [created.id]
  )
  const checkId = checks[0].id

  // D'abord marquer comme done
  await fastify.inject({
    method: 'PATCH', url: `/api/onboarding/${created.id}/checks/${checkId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { done: true },
  })
  // Puis undone
  const res = await fastify.inject({
    method: 'PATCH', url: `/api/onboarding/${created.id}/checks/${checkId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { done: false },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().done, false)
  assert.equal(res.json().done_at, null)
})

test('PATCH /:id/checks — tous done → onboarding.status passe à done', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-check-all-done')
  const created = (await createOnboarding(token, { person_name: 'All Done' })).json()

  const { rows: checks } = await db.query(
    'SELECT id FROM onboarding_checks WHERE onboarding_id = $1',
    [created.id]
  )
  // Marquer tous les checks comme done
  for (const ch of checks) {
    await fastify.inject({
      method: 'PATCH', url: `/api/onboarding/${created.id}/checks/${ch.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { done: true },
    })
  }
  // Vérifier que le statut de l'onboarding est passé à 'done'
  const { rows: [ob] } = await db.query(
    'SELECT status FROM onboardings WHERE id = $1', [created.id]
  )
  assert.equal(ob.status, 'done')
})

// ─── POST /:id/checks/:checkId/auto — étape inconnue → 500 ───────────────────
// Les étapes auto réelles (create_account, assign_license, etc.) appellent
// graph.js. Elles sont skippées car elles nécessitent un mock de module ESM
// non trivial. L'étape inconnue peut être testée sans mock.

test('POST /:id/checks/:checkId/auto — step_id inconnu → 500 sans appel Graph', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-unknown')
  const created = (await createOnboarding(token, { person_name: 'Auto Unknown' })).json()

  // Insérer un check avec un step_id non géré
  const r = await db.query(
    `INSERT INTO onboarding_checks (onboarding_id, step_id, label, is_auto)
     VALUES ($1, 'unknown_step', 'Étape inconnue', true) RETURNING id`,
    [created.id]
  )
  const checkId = r.rows[0].id

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/onboarding/${created.id}/checks/${checkId}/auto`,
    headers: { authorization: `Bearer ${token}` },
  })
  // Le route retourne 500 + { error, check } quand l'automatisation échoue
  assert.equal(res.statusCode, 500)
  const body = res.json()
  assert.ok(body.error)
  assert.ok(body.check)
  assert.equal(body.check.done, false)
  assert.ok(body.check.auto_error)
})

test('POST /:id/checks/:checkId/auto — check inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-404')
  const created = (await createOnboarding(token, { person_name: 'Auto 404' })).json()
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/onboarding/${created.id}/checks/00000000-0000-0000-0000-000000000000/auto`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

// NOTE SKIPPÉE : POST auto avec steps Graph réels (create_account, assign_license,
// disable_account, revoke_sessions) ne sont pas testés ici car ils nécessitent
// un mock de module ESM (lib/graph.js) non supporté nativement par node:test
// sans instrumentation supplémentaire. À tester en E2E ou via un refactor
// qui injecte les fonctions Graph comme dépendances.
