// routes/onboarding.js — couverture des chemins critiques :
// - GET / (liste avec filtres kind/status)
// - POST / (créer + génération checklist)
// - GET /:id (détail avec checks)
// - PATCH /:id (update champs)
// - DELETE /:id
// - PATCH /:id/checks/:checkId (toggle manuel + auto-status)
//
// POST /:id/checks/:checkId/auto : fait appel à graph.js (createEntraUser,
// addUserToGroup, disableEntraUser, revokeUserSessions). create_account est
// couvert en stubbant globalThis.fetch (utilisé par graph.js pour le token
// et pour Graph) ; step_id inconnu → 500 sans aucun appel Graph. Les autres
// étapes Graph (assign_license, disable_account…) ne sont pas couvertes.

import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Sécu : l'onboarding contient des données RH (et historiquement le mot de
// passe temporaire du nouveau compte). Ce test assertait l'inverse (route
// ouverte aux authentifiés) — il vérifie désormais le refus aux non-admins.
test('GET /:id — non-admin → 403 (données RH réservées aux admins)', { skip: SKIP }, async () => {
  const adminTok = await adminToken('oid-ob-get-nonadmin-setup')
  const created = (await createOnboarding(adminTok, { person_name: 'Readable' })).json()
  const token = await userToken('oid-ob-get-nonadmin')
  const res = await fastify.inject({
    method: 'GET', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET / — non-admin → 403', { skip: SKIP }, async () => {
  const adminTok = await adminToken('oid-ob-list-nonadmin-setup')
  await createOnboarding(adminTok, { person_name: 'Listed' })
  const token = await userToken('oid-ob-list-nonadmin')
  const res = await fastify.inject({
    method: 'GET', url: '/api/onboarding/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
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
// Les étapes auto réelles appellent graph.js : create_account est testé plus
// bas via un stub de globalThis.fetch. L'étape inconnue se teste sans stub.

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

// NOTE : create_account est couvert ci-dessous (stub de globalThis.fetch,
// sans mock de module ESM). assign_license, assign_groups, disable_account et
// revoke_sessions ne sont pas couverts : même technique applicable si besoin.

// ─── create_account : mot de passe temporaire jamais stocké ──────────────────
// createEntraUser (lib/graph.js) passe par globalThis.fetch : on le stubbe
// (token OAuth + POST /users) plutôt que de mocker le module ESM.

function mockGraphCreateUser(user) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const s = String(url)
    calls.push({ url: s, opts })
    if (/login\.microsoftonline\.com.*token/.test(s)) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    }
    if (s === 'https://graph.microsoft.com/v1.0/users' && opts?.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ '@odata.context': 'ctx', ...user }) }
    }
    throw new Error(`fetch inattendu : ${s}`)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('POST auto create_account — mot de passe renvoyé une fois, jamais stocké (notes, auto_result, GET)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-create')
  const created = (await createOnboarding(token, {
    person_name: 'Nouvelle Recrue', email: 'nouvelle.recrue@contoso.fr', notes: 'Arrivée lundi',
  })).json()
  const { rows: [check] } = await db.query(
    `SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'create_account'`, [created.id]
  )
  const entraId = '3c4d5e6f-0000-4000-8000-000000000042'
  const mock = mockGraphCreateUser({ id: entraId, userPrincipalName: 'nouvelle.recrue@contoso.fr' })

  let res
  try {
    res = await fastify.inject({
      method: 'POST', url: `/api/onboarding/${created.id}/checks/${check.id}/auto`,
      headers: { authorization: `Bearer ${token}` },
    })
  } finally {
    mock.restore()
  }
  assert.equal(res.statusCode, 200)
  const body = res.json()
  const pwd = body.result?.temporaryPassword
  assert.ok(pwd && pwd.length === 14, 'le mot de passe est renvoyé une fois dans la réponse')
  assert.equal(res.headers['cache-control'], 'no-store')
  // Le mot de passe envoyé à Graph est bien celui renvoyé à l'admin.
  const post = mock.calls.find(c => c.opts?.method === 'POST' && c.url.endsWith('/users'))
  assert.equal(JSON.parse(post.opts.body).passwordProfile.password, pwd)

  assert.ok(!JSON.stringify(body.check).includes(pwd), 'check renvoyé sans mot de passe')

  const { rows: [ob] } = await db.query('SELECT notes, entra_id_created FROM onboardings WHERE id = $1', [created.id])
  assert.equal(ob.entra_id_created, entraId)
  assert.ok(!ob.notes.includes(pwd), 'notes sans mot de passe')
  assert.match(ob.notes, /Compte créé : nouvelle\.recrue@contoso\.fr/)
  assert.match(ob.notes, /^Arrivée lundi\n/)

  const { rows: [chk] } = await db.query('SELECT auto_result FROM onboarding_checks WHERE id = $1', [check.id])
  assert.ok(!chk.auto_result.includes(pwd), 'auto_result sans mot de passe')
  assert.ok(!chk.auto_result.includes('temporaryPassword'))
  assert.equal(JSON.parse(chk.auto_result).id, entraId)

  const detail = await fastify.inject({
    method: 'GET', url: `/api/onboarding/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.ok(!detail.body.includes(pwd), 'GET /:id ne ré-expose jamais le mot de passe')
})

// ─── Migration 075 : purge des mots de passe déjà stockés ────────────────────
// On reproduit EXACTEMENT les écritures de l'ancien code (même UPDATE notes,
// même JSON.stringify pour auto_result) puis on rejoue le fichier SQL.

const MIGRATION_075 = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations/075_strip_onboarding_temp_passwords.sql'
)

test('Migration 075 : retire uniquement le mot de passe des notes et de auto_result (idempotente)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-mig075')
  const created = (await createOnboarding(token, { person_name: 'Legacy Pwd', notes: 'Bureau 12' })).json()
  const { rows: [check] } = await db.query(
    `SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'create_account'`, [created.id]
  )
  const pwd = 'aB3$xY7!kLm9@Q'
  const upn = 'legacy.pwd@contoso.fr'

  // Écritures de l'ancien code (onboarding.js avant correctif).
  const note = `Compte créé : ${upn}\nMot de passe temporaire : ${pwd}`
  await db.query(
    'UPDATE onboardings SET notes = COALESCE(notes || E\'\\n\', \'\') || $1 WHERE id = $2',
    [note, created.id]
  )
  await db.query('UPDATE onboardings SET notes = notes || E\'\\n\' || $1 WHERE id = $2', ['Badge remis', created.id])
  const legacyResult = {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
    id: '4d5e6f70-0000-4000-8000-000000000075', displayName: 'Legacy Pwd',
    userPrincipalName: upn, temporaryPassword: pwd,
  }
  await db.query('UPDATE onboarding_checks SET auto_result = $1 WHERE id = $2',
    [JSON.stringify(legacyResult), check.id])
  // Ligne témoin sans mot de passe : ne doit pas bouger.
  const other = (await createOnboarding(token, { person_name: 'Sans Pwd', notes: 'RAS' })).json()

  const sql = await fs.readFile(MIGRATION_075, 'utf8')
  await db.query(sql)

  const { rows: [ob] } = await db.query('SELECT notes FROM onboardings WHERE id = $1', [created.id])
  assert.equal(ob.notes, `Bureau 12\nCompte créé : ${upn}\nMot de passe temporaire : [supprimé]\nBadge remis`)
  const { rows: [chk] } = await db.query('SELECT auto_result FROM onboarding_checks WHERE id = $1', [check.id])
  const { temporaryPassword: _, ...expected } = legacyResult
  assert.deepEqual(JSON.parse(chk.auto_result), expected)
  const { rows: [untouched] } = await db.query('SELECT notes FROM onboardings WHERE id = $1', [other.id])
  assert.equal(untouched.notes, 'RAS')

  // Idempotence (CI rejoue chaque migration deux fois).
  await db.query(sql)
  const { rows: [ob2] } = await db.query('SELECT notes FROM onboardings WHERE id = $1', [created.id])
  assert.equal(ob2.notes, ob.notes)
  const { rows: [chk2] } = await db.query('SELECT auto_result FROM onboarding_checks WHERE id = $1', [check.id])
  assert.equal(chk2.auto_result, chk.auto_result)
})

// ─── create_account : échec DB après création Entra → résultat conservé ────
// Le compte Entra existe dès que Graph a répondu : si une écriture DB échoue
// ensuite, la réponse doit quand même porter le mot de passe temporaire (seul
// endroit où il existe), avec un avertissement, et non un 500 qui le perd.
// L'échec est provoqué par un trigger Postgres réel, limité à cette fiche.

test('POST auto create_account — échec DB après création Entra → 200 + mot de passe + warning', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-dbfail')
  const created = (await createOnboarding(token, {
    person_name: 'Echec DB Onboarding', email: 'echec.db@contoso.fr',
  })).json()
  const { rows: [check] } = await db.query(
    `SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'create_account'`, [created.id]
  )
  await db.query(`
    CREATE OR REPLACE FUNCTION t_fail_entra_id_created() RETURNS trigger AS $$
    BEGIN
      IF NEW.person_name = 'Echec DB Onboarding' THEN
        RAISE EXCEPTION 'panne DB simulée';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER t_fail_entra_id_created BEFORE UPDATE OF entra_id_created ON onboardings
      FOR EACH ROW EXECUTE FUNCTION t_fail_entra_id_created();
  `)
  const entraId = '6f708192-0000-4000-8000-0000000000db'
  const mock = mockGraphCreateUser({ id: entraId, userPrincipalName: 'echec.db@contoso.fr' })

  let res
  try {
    res = await fastify.inject({
      method: 'POST', url: `/api/onboarding/${created.id}/checks/${check.id}/auto`,
      headers: { authorization: `Bearer ${token}` },
    })
  } finally {
    mock.restore()
    await db.query(`
      DROP TRIGGER IF EXISTS t_fail_entra_id_created ON onboardings;
      DROP FUNCTION IF EXISTS t_fail_entra_id_created();
    `)
  }

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json()
  const pwd = body.result?.temporaryPassword
  assert.ok(pwd && pwd.length === 14, 'le mot de passe est renvoyé malgré l\'échec DB')
  assert.equal(body.result.id, entraId)
  assert.match(body.warning, /panne DB simulée/)
  assert.match(body.warning, /mot de passe temporaire/)

  // Rien n'a été écrit (ni id, ni mot de passe) ; l'étape reste à faire.
  const { rows: [ob] } = await db.query('SELECT notes, entra_id_created FROM onboardings WHERE id = $1', [created.id])
  assert.equal(ob.entra_id_created, null)
  assert.ok(!(ob.notes || '').includes(pwd))
  const { rows: [chk] } = await db.query('SELECT done, auto_result FROM onboarding_checks WHERE id = $1', [check.id])
  assert.equal(chk.done, false)
  assert.equal(chk.auto_result, null)
})

test('POST auto — automatisation en échec : toujours 500 avec auto_error (inchangé)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-noemail')
  const created = (await createOnboarding(token, { person_name: 'Sans Email' })).json()
  const { rows: [check] } = await db.query(
    `SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'create_account'`, [created.id]
  )
  const res = await fastify.inject({
    method: 'POST', url: `/api/onboarding/${created.id}/checks/${check.id}/auto`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 500)
  assert.match(res.json().error, /Email requis/)
  assert.equal(res.json().check.auto_error, 'Email requis pour créer le compte')
  assert.equal(res.json().warning, undefined)
})

test('POST auto create_account — passwordProfile renvoyé par Graph jamais stocké dans auto_result', { skip: SKIP }, async () => {
  const token = await adminToken('oid-ob-auto-pwdprofile')
  const created = (await createOnboarding(token, {
    person_name: 'Password Profile', email: 'password.profile@contoso.fr',
  })).json()
  const { rows: [check] } = await db.query(
    `SELECT id FROM onboarding_checks WHERE onboarding_id = $1 AND step_id = 'create_account'`, [created.id]
  )
  const mock = mockGraphCreateUser({
    id: '708192a3-0000-4000-8000-0000000000ff',
    userPrincipalName: 'password.profile@contoso.fr',
    passwordProfile: { password: 'EchoGraph#2026', forceChangePasswordNextSignIn: true },
  })
  let res
  try {
    res = await fastify.inject({
      method: 'POST', url: `/api/onboarding/${created.id}/checks/${check.id}/auto`,
      headers: { authorization: `Bearer ${token}` },
    })
  } finally {
    mock.restore()
  }
  assert.equal(res.statusCode, 200)
  const { rows: [chk] } = await db.query('SELECT auto_result FROM onboarding_checks WHERE id = $1', [check.id])
  assert.ok(!chk.auto_result.includes('EchoGraph'), 'auto_result sans passwordProfile')
  assert.ok(!chk.auto_result.includes('passwordProfile'))
})
