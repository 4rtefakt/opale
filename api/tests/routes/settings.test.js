// routes/settings.js : PATCH (allowlist + validation), POST/DELETE tokens
// agent (révocation + audit), GET /audit (filtres et pagination).
//
// Focus PR7 : la validation des champs sensibles (laps_recovery_username,
// compliance_alerts_enabled) et la mécanique d'audit_logs. Les autres
// endpoints (ssh-keys, admins/:entraId, sync-intune) suivent le même
// pattern et sont extrapolables.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import settingsRoute from '../../modules/core/routes/settings.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt
let cacheCalls = { branding: 0, manifest: 0 }
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  // Les decorators invalidateBrandingCache et invalidateManifestCache
  // sont définis par les plugins branding.js / manifest.js qu'on ne
  // charge pas en test — on stubbe ici pour ne pas péter à l'appel
  // depuis PATCH /.
  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    decorators: {
      invalidateBrandingCache: () => { cacheCalls.branding++ },
      invalidateManifestCache: () => { cacheCalls.manifest++ },
    },
    routes: async (f) => {
      await f.register(settingsRoute, { prefix: '/api/settings' })
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

async function adminAuth(entraId = 'oid-set-admin') {
  const a = await seedAdmin(db, { entraId })
  return { user: a, token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }) }
}

// ─── PATCH / — validation des champs sensibles ──────────────────────────────

test('PATCH / — 401 sans Bearer', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'PATCH', url: '/api/settings/', payload: {} })
  assert.equal(res.statusCode, 401)
})

test('PATCH / — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-set-nonadmin' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/settings/',
    headers: { authorization: `Bearer ${token}` },
    payload: { 'disk_warn_pct': '80' },
  })
  assert.equal(res.statusCode, 403)
})

test('PATCH / — key hors allowlist → ignorée silencieusement (pas d\'erreur)', { skip: SKIP }, async () => {
  // Defense in depth : un client qui envoie une key inconnue n'a pas
  // d'erreur (compat front), mais elle n'est pas écrite en DB.
  const { token } = await adminAuth('oid-set-allowlist')
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/settings/',
    headers: { authorization: `Bearer ${token}` },
    payload: { hacked_key: 'evil', disk_warn_pct: '85' },
  })
  assert.equal(res.statusCode, 200)
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'hacked_key'`)
  assert.equal(rows.length, 0, 'hors-allowlist NE doit PAS être écrite')
  const { rows: ok } = await db.query(`SELECT value FROM settings WHERE key = 'disk_warn_pct'`)
  assert.equal(ok[0].value, '85', 'allowlisté écrite')
})

test('PATCH / — agent.laps_recovery_username vide → 400', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-laps-empty')
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/settings/',
    headers: { authorization: `Bearer ${token}` },
    payload: { 'agent.laps_recovery_username': '' },
  })
  assert.equal(res.statusCode, 400)
})

test('PATCH / — agent.laps_recovery_username = "administrator" → 400 (banned)', { skip: SKIP }, async () => {
  // Sécu : un compte LAPS recovery nommé "administrator" sur Windows EN/FR
  // est probablement le BUILTIN admin local — privilège élevé indu. Le
  // serveur refuse même si l'agent Go le refuse aussi (defense in depth).
  const { token } = await adminAuth('oid-set-laps-banned')
  for (const banned of ['administrator', 'Administrateur', 'admin', 'root', 'system']) {
    const res = await fastify.inject({
      method: 'PATCH', url: '/api/settings/',
      headers: { authorization: `Bearer ${token}` },
      payload: { 'agent.laps_recovery_username': banned },
    })
    assert.equal(res.statusCode, 400, `${banned} doit être refusé`)
  }
})

test('PATCH / — agent.laps_recovery_username caractères invalides → 400', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-laps-invalid')
  for (const bad of ['has space', 'tab\there', 'with$pec', 'a'.repeat(33)]) {
    const res = await fastify.inject({
      method: 'PATCH', url: '/api/settings/',
      headers: { authorization: `Bearer ${token}` },
      payload: { 'agent.laps_recovery_username': bad },
    })
    assert.equal(res.statusCode, 400, `${bad} doit être refusé`)
  }
})

test('PATCH / — agent.laps_recovery_username valide → 200 + persisté', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-laps-ok')
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/settings/',
    headers: { authorization: `Bearer ${token}` },
    payload: { 'agent.laps_recovery_username': 'opale-recovery' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json()['agent.laps_recovery_username'], 'opale-recovery')
})

test('PATCH / — compliance_alerts_enabled doit être "true" ou "false" exact', { skip: SKIP }, async () => {
  // Le code lit `value === 'true'` côté compliance.js : '1' ou 'yes'
  // seraient lus comme false silencieusement. On refuse explicitement.
  const { token } = await adminAuth('oid-set-comp-strict')
  for (const bad of ['1', 'yes', 'TRUE', 'enabled']) {
    const res = await fastify.inject({
      method: 'PATCH', url: '/api/settings/',
      headers: { authorization: `Bearer ${token}` },
      payload: { compliance_alerts_enabled: bad },
    })
    assert.equal(res.statusCode, 400, `${bad} doit être refusé`)
  }
  // 'true' et 'false' acceptés.
  for (const ok of ['true', 'false']) {
    const res = await fastify.inject({
      method: 'PATCH', url: '/api/settings/',
      headers: { authorization: `Bearer ${token}` },
      payload: { compliance_alerts_enabled: ok },
    })
    assert.equal(res.statusCode, 200)
  }
})

test('PATCH / — clé branding → invalidateBrandingCache + invalidateManifestCache appelés', { skip: SKIP }, async () => {
  const before = { ...cacheCalls }
  const { token } = await adminAuth('oid-set-branding')
  const res = await fastify.inject({
    method: 'PATCH', url: '/api/settings/',
    headers: { authorization: `Bearer ${token}` },
    payload: { 'org.name': 'Test Org' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(cacheCalls.branding, before.branding + 1)
  assert.equal(cacheCalls.manifest, before.manifest + 1)
})

// ─── POST /tokens — création + audit ────────────────────────────────────────

test('POST /tokens — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/settings/tokens', payload: { label: 'x' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /tokens — label manquant → 400', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-tok-empty')
  const res = await fastify.inject({
    method: 'POST', url: '/api/settings/tokens',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  })
  assert.equal(res.statusCode, 400)
})

test('POST /tokens — happy path retourne token clair + audit token_created', { skip: SKIP }, async () => {
  const { user, token } = await adminAuth('oid-set-tok-ok', 'TokenCreator')
  const res = await fastify.inject({
    method: 'POST', url: '/api/settings/tokens',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'New device token' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.equal(body.label, 'New device token')
  assert.match(body.token, /^[0-9a-f]{64}$/, 'token agent = 64 hex (sans préfixe opl_)')

  const { rows } = await db.query(
    `SELECT by_user, target FROM audit_logs WHERE action = 'token_created'`
  )
  assert.ok(rows.length >= 1)
  assert.equal(rows[0].by_user, user.displayName)
  assert.equal(rows[0].target, 'New device token')
})

// ─── DELETE /tokens/:id — révocation + audit ───────────────────────────────

test('DELETE /tokens/:id — token inexistant → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-revoke-404')
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/settings/tokens/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('DELETE /tokens/:id — happy path : UPDATE revoked_at + audit token_revoked', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-revoke-ok', 'Revoker Admin')
  // Crée d'abord un token via POST /tokens (pour avoir l'id).
  const created = await fastify.inject({
    method: 'POST', url: '/api/settings/tokens',
    headers: { authorization: `Bearer ${token}` },
    payload: { label: 'to-revoke' },
  })
  const tokenId = created.json().id

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${tokenId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 204, '204 No Content sur révocation réussie')

  const { rows } = await db.query(`SELECT revoked_at FROM agent_tokens WHERE id = $1`, [tokenId])
  assert.ok(rows[0].revoked_at, 'revoked_at doit être set')

  // 2e DELETE sur le même id → 404 (déjà révoqué).
  const res2 = await fastify.inject({
    method: 'DELETE', url: `/api/settings/tokens/${tokenId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res2.statusCode, 404, 'double-revoke doit retourner 404 (UPDATE ... AND revoked_at IS NULL)')
})

// ─── GET /audit — filtres et pagination ────────────────────────────────────

async function seedAudit(action, byUser, target = null, details = null) {
  await db.query(
    `INSERT INTO audit_logs (action, by_user, target, details) VALUES ($1, $2, $3, $4)`,
    [action, byUser, target, details ? JSON.stringify(details) : null]
  )
}

test('GET /audit — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/settings/audit' })
  assert.equal(res.statusCode, 401)
})

test('GET /audit — filtre action exact', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-audit-exact')
  await seedAudit('test_action_a', 'user1', 'target1')
  await seedAudit('test_action_b', 'user1', 'target2')

  const res = await fastify.inject({
    method: 'GET', url: '/api/settings/audit?action=test_action_a',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  for (const r of body.rows) assert.equal(r.action, 'test_action_a')
  assert.ok(body.rows.find(r => r.target === 'target1'))
  assert.ok(!body.rows.find(r => r.action === 'test_action_b'))
})

test('GET /audit — filtre actions_in CSV', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-audit-in')
  await seedAudit('audit_in_x', 'u', 't')
  await seedAudit('audit_in_y', 'u', 't')
  await seedAudit('audit_in_z', 'u', 't')

  const res = await fastify.inject({
    method: 'GET', url: '/api/settings/audit?actions_in=audit_in_x,audit_in_z',
    headers: { authorization: `Bearer ${token}` },
  })
  const actions = res.json().rows.map(r => r.action)
  assert.ok(actions.includes('audit_in_x'))
  assert.ok(actions.includes('audit_in_z'))
  assert.ok(!actions.includes('audit_in_y'))
})

test('GET /audit — filtre actions_not_in (exclusion)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-audit-not-in')
  await seedAudit('audit_keep', 'u', 't')
  await seedAudit('audit_noisy_X', 'u', 't')
  await seedAudit('audit_noisy_Y', 'u', 't')

  const res = await fastify.inject({
    method: 'GET', url: '/api/settings/audit?actions_not_in=audit_noisy_X,audit_noisy_Y',
    headers: { authorization: `Bearer ${token}` },
  })
  const actions = res.json().rows.map(r => r.action)
  assert.ok(actions.includes('audit_keep'))
  assert.ok(!actions.includes('audit_noisy_X'))
  assert.ok(!actions.includes('audit_noisy_Y'))
})

test('GET /audit — filtre level via details->>"level"', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-audit-level')
  await seedAudit('agent_checkin', 'u', 't', { level: 'warn', msg: 'noisy' })
  await seedAudit('agent_checkin', 'u', 't', { level: 'info', msg: 'normal' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/settings/audit?level=warn',
    headers: { authorization: `Bearer ${token}` },
  })
  for (const r of res.json().rows) {
    assert.equal(r.details?.level, 'warn')
  }
})

test('GET /audit — structure : { rows, total } avec pagination', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-set-audit-pagi')
  const res = await fastify.inject({
    method: 'GET', url: '/api/settings/audit?limit=10',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(Array.isArray(body.rows))
  assert.equal(typeof body.total, 'number')
  assert.ok(body.rows.length <= 10)
})
