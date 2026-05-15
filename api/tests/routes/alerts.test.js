// routes/alerts.js : GET /api/alerts — alertes calculées à la volée depuis devices.
// Contrat : { disk_critical, disk_warn, offline, non_compliant, counts: { critical, warn } }
// Les snoozés sont présents dans les listes mais exclus des counts.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import alertsRoute from '../../modules/monitoring/routes/alerts.js'

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
      await f.register(alertsRoute, { prefix: '/api/alerts' })
    },
  })

  // Seuils explicites pour que les tests ne dépendent pas des valeurs seedées
  // par 005_settings.sql (80/90) qui peuvent différer de nos fixtures.
  await db.query(`
    INSERT INTO settings (key, value)
    VALUES ('disk_critical_pct','95'),('disk_warn_pct','80'),('agent_offline_days','7')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `)
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('GET /api/alerts — sans JWT → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/alerts/' })
  assert.equal(res.statusCode, 401)
})

test('GET /api/alerts — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-alerts-nonadmin', email: 'nonadmin-al@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'GET', url: '/api/alerts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// ─── Disque critique ──────────────────────────────────────────────────────────

test('GET /api/alerts — disk_used_pct ≥ 95 → apparaît dans disk_critical + counts.critical', { skip: SKIP }, async () => {
  const u = await seedAdmin(db, { entraId: 'oid-alerts-crit', email: 'admin-crit@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })

  // Device avec disque critique (96% ≥ 95)
  const { rows: [device] } = await db.query(
    `INSERT INTO devices (hostname, disk_used_pct, source, last_seen)
     VALUES ('PC-CRIT', 96, 'agent', now()) RETURNING id, hostname`
  )

  const res = await fastify.inject({
    method: 'GET', url: '/api/alerts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  assert.ok(Array.isArray(body.disk_critical))
  const hit = body.disk_critical.find(r => r.hostname === 'PC-CRIT')
  assert.ok(hit, 'PC-CRIT devrait apparaître dans disk_critical')
  assert.equal(hit.disk_used_pct, 96)

  // counts.critical doit inclure ce device
  assert.ok(body.counts.critical >= 1)

  // Nettoyage
  await db.query('DELETE FROM devices WHERE id = $1', [device.id])
})

// ─── Offline ──────────────────────────────────────────────────────────────────

test('GET /api/alerts — agent offline depuis > 7 jours → dans offline + counts.warn', { skip: SKIP }, async () => {
  const u = await seedAdmin(db, { entraId: 'oid-alerts-offline', email: 'admin-offline@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })

  // Device agent vu il y a 10 jours
  const lastSeen = new Date(Date.now() - 10 * 24 * 3600_000).toISOString()
  const { rows: [device] } = await db.query(
    `INSERT INTO devices (hostname, disk_used_pct, source, last_seen)
     VALUES ('PC-OFFLINE', 10, 'agent', $1) RETURNING id`,
    [lastSeen]
  )

  const res = await fastify.inject({
    method: 'GET', url: '/api/alerts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  const hit = body.offline.find(r => r.hostname === 'PC-OFFLINE')
  assert.ok(hit, 'PC-OFFLINE devrait apparaître dans offline')
  assert.ok(body.counts.warn >= 1)

  await db.query('DELETE FROM devices WHERE id = $1', [device.id])
})

// ─── Snooze ───────────────────────────────────────────────────────────────────

test('GET /api/alerts — alerte snoozée → présente dans la liste mais exclue des counts', { skip: SKIP }, async () => {
  const u = await seedAdmin(db, { entraId: 'oid-alerts-snooze', email: 'admin-snooze@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })

  // Device avec disque critique (97%)
  const { rows: [device] } = await db.query(
    `INSERT INTO devices (hostname, disk_used_pct, source, last_seen)
     VALUES ('PC-SNOOZE', 97, 'agent', now()) RETURNING id`
  )

  // Snooze actif pour disk_critical sur ce device
  const untilAt = new Date(Date.now() + 24 * 3600_000).toISOString()
  await db.query(
    `INSERT INTO alert_snoozes (device_id, alert_type, until_at)
     VALUES ($1, 'disk_critical', $2)`,
    [device.id, untilAt]
  )

  const res = await fastify.inject({
    method: 'GET', url: '/api/alerts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  const hit = body.disk_critical.find(r => r.hostname === 'PC-SNOOZE')
  assert.ok(hit, 'PC-SNOOZE doit rester dans la liste même snoozé')
  assert.ok(hit.snoozed_until, 'snoozed_until doit être renseigné')

  // Doit être exclu du compteur
  const nonSnoozedCrits = body.disk_critical.filter(r => !r.snoozed_until)
  assert.equal(body.counts.critical, nonSnoozedCrits.length + body.non_compliant.filter(r => !r.snoozed_until).length)

  await db.query('DELETE FROM devices WHERE id = $1', [device.id])
})

// ─── Contrat de réponse ───────────────────────────────────────────────────────

test('GET /api/alerts — structure de réponse correcte', { skip: SKIP }, async () => {
  const u = await seedAdmin(db, { entraId: 'oid-alerts-struct', email: 'admin-struct@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })

  const res = await fastify.inject({
    method: 'GET', url: '/api/alerts/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  assert.ok(Array.isArray(body.disk_critical))
  assert.ok(Array.isArray(body.disk_warn))
  assert.ok(Array.isArray(body.offline))
  assert.ok(Array.isArray(body.non_compliant))
  assert.equal(typeof body.counts.critical, 'number')
  assert.equal(typeof body.counts.warn, 'number')
})
