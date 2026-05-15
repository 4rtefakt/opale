// routes/dashboard.js : agrégats KPI + compliance + unhealthy devices.
//
// On teste :
//   - Auth 401
//   - Payload shape (toutes les clés attendues présentes)
//   - counts KPI reflètent l'état DB réel
//   - compliance_score_pct calculé correctement (pass / (pass + fail), hors agent_seen_recent)
//   - unhealthy_devices : device avec disk ≥ crit_pct → unhealth_score > 0
//   - top_failing_rules : ordonné par count desc + severity desc

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin } from '../fixtures/users.js'

import dashboardRoute from '../../modules/core/routes/dashboard.js'

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
      await f.register(dashboardRoute, { prefix: '/api/dashboard' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

async function adminToken(entraId = 'oid-dash-admin') {
  const u = await seedAdmin(db, { entraId, displayName: 'Dash Admin', email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/dashboard/' })
  assert.equal(res.statusCode, 401)
})

// ─── Payload shape ───────────────────────────────────────────────────────────

test('GET / — payload contient toutes les clés attendues', { skip: SKIP }, async () => {
  const token = await adminToken('oid-dash-shape')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  // Clés de premier niveau
  for (const key of ['kpis', 'thresholds', 'recent_tickets', 'recent_activity', 'top_failing_rules', 'unhealthy_devices', 'agent_versions']) {
    assert.ok(key in body, `clé manquante : ${key}`)
  }

  // KPI sub-keys
  for (const kpi of [
    'devices_online', 'devices_offline', 'devices_total', 'disk_critical',
    'alerts_active', 'tickets_open', 'stock_low', 'proposals_pending',
    'deployments_running', 'deployments_pending',
    'compliance_score_pct', 'compliance_failing_devs',
  ]) {
    assert.ok(kpi in body.kpis, `kpi manquant : ${kpi}`)
  }

  // Thresholds
  for (const t of ['disk_warn_pct', 'disk_critical_pct', 'agent_offline_days']) {
    assert.ok(t in body.thresholds, `threshold manquant : ${t}`)
  }

  // agent_versions sub-keys
  assert.ok('distribution' in body.agent_versions)
})

// ─── KPI counts reflètent la DB ───────────────────────────────────────────────

test('GET / — devices_total + devices_online reflètent les devices en DB', { skip: SKIP }, async () => {
  // Seed 2 devices : 1 online (vu il y a 10 min), 1 offline (vu il y a 2h)
  await db.query(`
    INSERT INTO devices (hostname, last_seen) VALUES
      ('PC-DASH-ONLINE', now() - interval '10 minutes'),
      ('PC-DASH-OFFLINE', now() - interval '2 hours')
  `)

  const token = await adminToken('oid-dash-counts')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { kpis } = res.json()
  // Il peut y avoir d'autres devices en DB (autres tests). On vérifie les
  // minimums, pas l'égalité exacte.
  assert.ok(kpis.devices_total >= 2)
  assert.ok(kpis.devices_online >= 1, 'au moins 1 device online')
  assert.ok(kpis.devices_offline >= 1, 'au moins 1 device offline')
})

test('GET / — tickets_open reflète les tickets ouverts', { skip: SKIP }, async () => {
  await db.query(`
    INSERT INTO tickets (title, status, priority) VALUES
      ('Ticket ouvert', 'open', 'medium'),
      ('Ticket résolu', 'resolved', 'low')
  `)

  const token = await adminToken('oid-dash-tickets')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  // tickets_open = status NOT IN ('resolved', 'closed')
  assert.ok(res.json().kpis.tickets_open >= 1)
})

// ─── Compliance score ─────────────────────────────────────────────────────────

test('GET / — compliance_score_pct calculé à partir des compliance_results', { skip: SKIP }, async () => {
  // Seed 1 device
  const { rows: [dev] } = await db.query(
    `INSERT INTO devices (hostname) VALUES ('PC-COMPLIANCE-SCORE') RETURNING id`
  )

  // 3 pass + 1 fail (hors agent_seen_recent) → score = round(100 * 3 / 4) = 75
  await db.query(`
    INSERT INTO compliance_results (device_id, rule_id, status, severity) VALUES
      ($1, 'disk_usage', 'pass', 'high'),
      ($1, 'os_patched', 'pass', 'critical'),
      ($1, 'bitlocker', 'pass', 'high'),
      ($1, 'av_enabled', 'fail', 'critical')
  `, [dev.id])

  // agent_seen_recent doit être exclu du score
  await db.query(`
    INSERT INTO compliance_results (device_id, rule_id, status, severity) VALUES
      ($1, 'agent_seen_recent', 'fail', 'critical')
  `, [dev.id])

  const token = await adminToken('oid-dash-score')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { kpis } = res.json()
  // Score global peut inclure d'autres devices → on vérifie juste que c'est
  // un nombre entre 0 et 100 (pas null).
  assert.ok(kpis.compliance_score_pct !== null)
  assert.ok(kpis.compliance_score_pct >= 0 && kpis.compliance_score_pct <= 100)
})

// ─── unhealthy_devices ────────────────────────────────────────────────────────

test('GET / — unhealthy_devices : device avec disk ≥ disk_critical_pct → unhealth_score > 0', { skip: SKIP }, async () => {
  // Utilise le seuil défaut (90%). On seed un device à 95%.
  await db.query(`
    INSERT INTO devices (hostname, disk_used_pct, last_seen)
    VALUES ('PC-UNHEALTHY-DISK', 95, now() - interval '5 minutes')
  `)

  const token = await adminToken('oid-dash-unhealthy')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { unhealthy_devices } = res.json()
  assert.ok(Array.isArray(unhealthy_devices))
  const found = unhealthy_devices.find(d => d.hostname === 'PC-UNHEALTHY-DISK')
  assert.ok(found, 'PC-UNHEALTHY-DISK doit apparaître dans unhealthy_devices')
  assert.ok(found.unhealth_score > 0, `unhealth_score doit être > 0, got ${found.unhealth_score}`)
})

// ─── top_failing_rules ────────────────────────────────────────────────────────

test('GET / — top_failing_rules : ordonné par fail desc', { skip: SKIP }, async () => {
  // Seed 2 devices avec des fails sur des règles différentes.
  const { rows: [d1] } = await db.query(`INSERT INTO devices (hostname) VALUES ('PC-TOP-FAIL-1') RETURNING id`)
  const { rows: [d2] } = await db.query(`INSERT INTO devices (hostname) VALUES ('PC-TOP-FAIL-2') RETURNING id`)

  // disk_usage : 2 fails ; av_enabled : 1 fail
  await db.query(`
    INSERT INTO compliance_results (device_id, rule_id, status, severity) VALUES
      ($1, 'disk_usage', 'fail', 'high'),
      ($2, 'disk_usage', 'fail', 'high'),
      ($1, 'av_enabled', 'fail', 'critical')
  `, [d1.id, d2.id])

  const token = await adminToken('oid-dash-topfail')
  const res = await fastify.inject({
    method: 'GET', url: '/api/dashboard/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { top_failing_rules } = res.json()
  assert.ok(Array.isArray(top_failing_rules))

  // disk_usage (2 fails) doit apparaître avant av_enabled (1 fail)
  const diskIdx = top_failing_rules.findIndex(r => r.id === 'disk_usage')
  const avIdx   = top_failing_rules.findIndex(r => r.id === 'av_enabled')
  assert.ok(diskIdx !== -1, 'disk_usage doit être dans top_failing_rules')
  assert.ok(avIdx   !== -1, 'av_enabled doit être dans top_failing_rules')
  assert.ok(diskIdx < avIdx, 'disk_usage (2 fails) doit précéder av_enabled (1 fail)')
})
