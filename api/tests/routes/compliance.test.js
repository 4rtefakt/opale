// routes/compliance.js : 3 endpoints du dashboard compliance.
//
// Focus :
//   - Auth admin requise sur les 3 endpoints.
//   - Override LIVE de agent_seen_recent (depuis devices.last_seen +
//     agent_version, pas depuis la row figée dans compliance_results).
//     C'est LA particularité critique du fichier — sans cet override, les
//     devices offline garderaient leur dernier verdict 'pass' (la règle a
//     été évaluée au dernier checkin par construction). Cf. PR #92.
//   - Drill-down par règle inclut hostnames + user assigné.
//   - Fiche poste retourne TOUTES les 12 règles (pas seulement celles
//     évaluées) avec leur status effectif.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import complianceRoute from '../../modules/monitoring/routes/compliance.js'
import { RULES } from '../../modules/monitoring/lib/compliance.js'

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
      await f.register(complianceRoute, { prefix: '/api' })
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

async function adminAuth() {
  const a = await seedAdmin(db, { entraId: 'oid-comp-admin' })
  return await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })
}

// Insert un device + 12 rows compliance_results en pass (sauf l'override
// agent_seen_recent qui sera recalculé).
async function seedDeviceWithCompliance({ hostname, lastSeenHoursAgo = 0, agentVersion = '2.14.0' } = {}) {
  const last = new Date(Date.now() - lastSeenHoursAgo * 3600_000).toISOString()
  const r = await db.query(
    `INSERT INTO devices (hostname, last_seen, agent_version) VALUES ($1, $2, $3) RETURNING id`,
    [hostname, last, agentVersion]
  )
  const deviceId = r.rows[0].id
  for (const rule of RULES) {
    await db.query(
      `INSERT INTO compliance_results (device_id, rule_id, status, severity, value)
       VALUES ($1, $2, 'pass', $3, NULL)`,
      [deviceId, rule.id, rule.severity]
    )
  }
  return { deviceId }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

test('GET /api/compliance — 401 sans Bearer', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/compliance' })
  assert.equal(res.statusCode, 401)
})

test('GET /api/compliance — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-comp-nonadmin' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── GET /api/compliance (aggregate) ───────────────────────────────────────

test('GET /api/compliance — schéma vide : 12 règles avec total=0, score_pct=null', { skip: SKIP }, async () => {
  const token = await adminAuth()
  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.rules.length, 12, '12 règles attendues')
  for (const r of body.rules) {
    assert.equal(r.pass, 0)
    assert.equal(r.fail, 0)
    assert.equal(r.total, 0)
  }
  assert.equal(body.summary.devices_total, 0)
  assert.equal(body.summary.score_pct, null, 'score_pct null si aucune éval')
})

test('GET /api/compliance — override agent_seen_recent live (poste offline 48h)', { skip: SKIP }, async () => {
  // Critique : la row compliance_results dit 'pass' (figée au dernier
  // checkin). Mais l'API doit retourner 'fail' sur ce device car
  // last_seen > 24h. C'est la spécificité du fichier qu'on teste ici.
  const token = await adminAuth()
  await seedDeviceWithCompliance({ hostname: 'PC-OFFLINE-48H', lastSeenHoursAgo: 48 })
  await seedDeviceWithCompliance({ hostname: 'PC-FRESH', lastSeenHoursAgo: 0 })

  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  const live = body.rules.find(r => r.id === 'agent_seen_recent')
  assert.equal(live.pass, 1, '1 device < 24h → pass live')
  assert.equal(live.fail, 1, '1 device > 24h → fail live (override)')
  // Toutes les autres règles : 2 pass (rows en DB).
  for (const r of body.rules) {
    if (r.id === 'agent_seen_recent') continue
    assert.equal(r.pass, 2, `${r.id} doit avoir 2 pass`)
  }
})

test('GET /api/compliance — agent_version=null → agent_seen_recent N/A (poste non managé)', { skip: SKIP }, async () => {
  const token = await adminAuth()
  // Device sans agent_version (Intune-only, jamais checkin agent).
  await db.query(
    `INSERT INTO devices (hostname, last_seen, agent_version) VALUES ('PC-INTUNE-ONLY', now(), NULL)`
  )

  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance',
    headers: { authorization: `Bearer ${token}` },
  })
  const live = res.json().rules.find(r => r.id === 'agent_seen_recent')
  assert.equal(live.not_applicable, 1, 'sans agent_version → N/A (poste non managé par agent)')
})

// ─── GET /api/compliance/rules/:rule_id (drill-down) ───────────────────────

test('GET /rules/:rule_id — règle inconnue → 404', { skip: SKIP }, async () => {
  const token = await adminAuth()
  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance/rules/inexistante',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /rules/agent_seen_recent — override live retourne tous les devices', { skip: SKIP }, async () => {
  const token = await adminAuth()
  await seedDeviceWithCompliance({ hostname: 'PC-RULE-LIVE-1', lastSeenHoursAgo: 1 })
  await seedDeviceWithCompliance({ hostname: 'PC-RULE-LIVE-2', lastSeenHoursAgo: 36 })

  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance/rules/agent_seen_recent',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.rule.id, 'agent_seen_recent')
  assert.ok(body.devices.length >= 2)
  const live1 = body.devices.find(d => d.hostname === 'PC-RULE-LIVE-1')
  const live2 = body.devices.find(d => d.hostname === 'PC-RULE-LIVE-2')
  assert.equal(live1.status, 'pass')
  assert.equal(live2.status, 'fail')
})

test('GET /rules/bitlocker_c_active — retourne devices depuis compliance_results triés par status', { skip: SKIP }, async () => {
  const token = await adminAuth()
  const { deviceId: idPass } = await seedDeviceWithCompliance({ hostname: 'PC-BL-PASS' })
  const { deviceId: idFail } = await seedDeviceWithCompliance({ hostname: 'PC-BL-FAIL' })
  // Override la row BL du 2e device en fail.
  await db.query(
    `UPDATE compliance_results SET status = 'fail', value = '{"protection_status":"off"}'::jsonb
     WHERE device_id = $1 AND rule_id = 'bitlocker_c_active'`,
    [idFail]
  )

  const res = await fastify.inject({
    method: 'GET', url: '/api/compliance/rules/bitlocker_c_active',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  // L'ordre est : fail d'abord, puis not_applicable, puis pass.
  assert.equal(body.devices[0].status, 'fail', 'fail trié en premier')
  assert.ok(body.devices.find(d => d.device_id === idPass).status === 'pass')
})

// ─── GET /api/devices/:id/compliance ───────────────────────────────────────

test('GET /devices/:id/compliance — device inexistant → 404', { skip: SKIP }, async () => {
  const token = await adminAuth()
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/00000000-0000-0000-0000-000000000000/compliance',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /devices/:id/compliance — retourne TOUTES les 12 règles (même non évaluées)', { skip: SKIP }, async () => {
  // Garantie : la fiche poste affiche toujours 12 lignes, même pour un
  // device qui n'a pas encore checkin (compliance_results vide). Les règles
  // non présentes en DB → N/A par défaut.
  const token = await adminAuth()
  const r = await db.query(
    `INSERT INTO devices (hostname, last_seen, agent_version) VALUES ('PC-NEVER-CHECKIN', now(), NULL) RETURNING id`
  )
  const deviceId = r.rows[0].id

  const res = await fastify.inject({
    method: 'GET', url: `/api/devices/${deviceId}/compliance`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.results.length, 12)
  // Sans agent_version + sans rows DB → toutes N/A.
  for (const r of body.results) {
    assert.equal(r.status, 'not_applicable', `${r.rule_id} doit être N/A`)
  }
  assert.equal(body.counts.total, 12)
  assert.equal(body.counts.not_applicable, 12)
})

test('GET /devices/:id/compliance — agent_seen_recent overridé live, autres règles lues depuis DB', { skip: SKIP }, async () => {
  const token = await adminAuth()
  const { deviceId } = await seedDeviceWithCompliance({
    hostname: 'PC-FICHE', lastSeenHoursAgo: 30, // > 24h donc fail
  })
  const res = await fastify.inject({
    method: 'GET', url: `/api/devices/${deviceId}/compliance`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  const live = body.results.find(r => r.rule_id === 'agent_seen_recent')
  assert.equal(live.status, 'fail', 'override live : 30h > 24h → fail')

  // Toutes les autres règles : pass (depuis DB).
  for (const r of body.results) {
    if (r.rule_id === 'agent_seen_recent') continue
    assert.equal(r.status, 'pass', `${r.rule_id} doit être pass`)
  }
  // counts cohérents.
  assert.equal(body.counts.pass + body.counts.fail + body.counts.not_applicable, 12)
})
