// routes/rapports.js : rapport agrégé du parc (KPIs, activité, compliance…).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import rapportsRoute from '../../modules/monitoring/routes/rapports.js'

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
      await f.register(rapportsRoute, { prefix: '/api/rapports' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminToken(entraId = 'oid-rpt-admin', name = 'Rapport Admin') {
  const u = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
}

// ─── ACL ──────────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/rapports/' })
  assert.equal(res.statusCode, 401)
})

test('GET / — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-rpt-na', email: 'oid-rpt-na@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── Shape de retour ─────────────────────────────────────────────────────────

test('GET / — retourne les clés attendues', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-shape')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  // Clés racine
  assert.ok('kpis'          in body, 'kpis')
  assert.ok('compliance'    in body, 'compliance')
  assert.ok('activity'      in body, 'activity')
  assert.ok('tickets_by_tag' in body, 'tickets_by_tag')
  assert.ok('disk_top'      in body, 'disk_top')
  assert.ok('battery'       in body, 'battery')
})

test('GET / — kpis.parc a total + active_7d', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-kpis')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { kpis } = res.json()
  assert.equal(typeof kpis.parc.total,     'number')
  assert.equal(typeof kpis.parc.active_7d, 'number')
})

test('GET / — kpis.time_saved a minutes + eur + hourly_rate + annual_eur', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-timesaved')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  const { kpis } = res.json()
  const ts = kpis.time_saved
  assert.equal(typeof ts.minutes,     'number')
  assert.equal(typeof ts.eur,         'number')
  assert.equal(typeof ts.hourly_rate, 'number')
  assert.equal(typeof ts.annual_eur,  'number')
})

test('GET / — compliance a 6 entrées avec les bonnes clés', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-compliance')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  const { compliance } = res.json()
  assert.equal(compliance.length, 6)
  const keys = ['bitlocker', 'defender', 'firewall', 'tpm', 'reboot', 'update']
  for (const entry of compliance) {
    assert.ok(keys.includes(entry.key), `clé inconnue: ${entry.key}`)
    assert.equal(typeof entry.ok, 'number')
    assert.equal(typeof entry.ko, 'number')
    assert.equal(typeof entry.na, 'number')
  }
})

// ─── Calcul coût (audit_logs + automation_costs + cost_per_hour) ──────────────

test('GET / — activity reflète les audit_logs avec automation_costs', { skip: SKIP }, async () => {
  // Insérer 2 actions traçées dans audit_logs pour un type connu dans automation_costs.
  // script_executed_remote = 15 min × 2 = 30 min
  await db.query(
    `INSERT INTO audit_logs (action, by_user, target, created_at)
     VALUES
       ('script_executed_remote', 'oid-rpt-activity', 'PC-A', now()),
       ('script_executed_remote', 'oid-rpt-activity', 'PC-B', now())`
  )

  const token = await adminToken('oid-rpt-activity')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { activity } = res.json()

  const entry = activity.find(a => a.action_type === 'script_executed_remote')
  assert.ok(entry, 'script_executed_remote doit apparaître dans activity')
  assert.ok(entry.count >= 2, 'count doit être >= 2')
  assert.equal(entry.estimated_minutes, 15)
  assert.ok(entry.total_minutes >= 30, 'total_minutes >= 30')
  assert.ok(entry.total_eur >= 0, 'total_eur calculé')
})

test('GET / — actions enrichies (migration 061) sont mappées et comptées', { skip: SKIP }, async () => {
  // Régression migration 061 : ces action_types doivent avoir un mapping
  // automation_costs, sinon l'INNER JOIN les exclut du KPI.
  await db.query(
    `INSERT INTO audit_logs (action, by_user, target, created_at) VALUES
       ('compliance_changed',   'oid-rpt-061', 'PC-X', now()),
       ('agent_console_open',   'oid-rpt-061', 'PC-X', now()),
       ('laps_viewed',          'oid-rpt-061', 'PC-X', now())`
  )
  const token = await adminToken('oid-rpt-061')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { activity } = res.json()

  for (const [type, mins] of [['compliance_changed', 5], ['agent_console_open', 10], ['laps_viewed', 15]]) {
    const entry = activity.find(a => a.action_type === type)
    assert.ok(entry, `${type} doit apparaître dans activity (mapping 061)`)
    assert.equal(entry.estimated_minutes, mins, `${type} = ${mins} min`)
  }
})

test('GET / — gains tickets/mail comptés dans activity (migration 063, approche A)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-tickets-gains')

  // Seed des sources métier dans la fenêtre 30j :
  //  - 1 mail rattaché auto (message_appended)
  //  - 1 ticket créé depuis un mail (source=email)
  //  - 1 ticket fusionné (status=merged)
  const { rows: tk } = await db.query(
    `INSERT INTO tickets (title, source) VALUES ('Ticket mail', 'email') RETURNING id`
  )
  await db.query(
    `INSERT INTO tickets (title, status, updated_at) VALUES ('Doublon', 'merged', now())`
  )
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, received_at, ticket_id, action)
    VALUES ($1, 'helpdesk@test', 'inbound', now(), $2, 'message_appended')
  `, [`<gain-${Math.random().toString(36).slice(2)}@x>`, tk[0].id])

  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { activity } = res.json()

  const appended = activity.find(a => a.action_type === 'ticket_mail_appended')
  const fromMail = activity.find(a => a.action_type === 'ticket_from_email')
  const merged   = activity.find(a => a.action_type === 'ticket_merged')

  assert.ok(appended && appended.count >= 1, 'ticket_mail_appended présent')
  assert.equal(appended.estimated_minutes, 5)
  assert.ok(fromMail && fromMail.count >= 1, 'ticket_from_email présent')
  assert.equal(fromMail.estimated_minutes, 8)
  assert.ok(merged && merged.count >= 1, 'ticket_merged présent')
  assert.equal(merged.estimated_minutes, 10)
})

test('GET / — cost_per_hour absent → fallback 22.54 utilisé', { skip: SKIP }, async () => {
  // Supprimer le setting cost_per_hour pour tester le fallback.
  await db.query(`DELETE FROM settings WHERE key = 'cost_per_hour'`)

  const token = await adminToken('oid-rpt-fallback')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const { kpis } = res.json()
  // hourly_rate doit être le fallback 22.54
  assert.equal(kpis.time_saved.hourly_rate, 22.54)

  // Remettre cost_per_hour pour ne pas perturber les autres tests.
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('cost_per_hour', '22.54')
     ON CONFLICT (key) DO UPDATE SET value = '22.54'`
  )
})

test('GET / — tickets_by_tag a weeks (array) + datasets (array)', { skip: SKIP }, async () => {
  const token = await adminToken('oid-rpt-tickets-tag')
  const res = await fastify.inject({
    method: 'GET', url: '/api/rapports/',
    headers: { authorization: `Bearer ${token}` },
  })
  const { tickets_by_tag } = res.json()
  assert.ok(Array.isArray(tickets_by_tag.weeks))
  assert.ok(Array.isArray(tickets_by_tag.datasets))
})
