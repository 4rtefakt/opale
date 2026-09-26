// POST /api/agent/checkin — audit : plus une ligne par checkin (≈ 10 000
// lignes / jour pour 110 postes, 365 j de rétention), seulement les
// événements significatifs : enrôlement, changement de nom, série
// différente, version d'agent changée, ip_netbird refusée. Les
// rattachements / refus de token ont leurs propres actions (inchangées).
// Et : le nettoyage des séries temporelles au checkin suit lib/retention.js.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { retentionDays } from '../../lib/retention.js'

import agentRoute from '../../modules/inventory/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db, release, fastify

before(async () => {
  if (!isDbAvailable()) return
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  fastify = await buildApp({
    db,
    registerAuth: false,
    routes: async (f) => { await f.register(agentRoute, { prefix: '/api/agent' }) },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

function checkin(secret, payload) {
  return fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload,
  })
}

async function device({ hostname, serial = null, agentVersion = null }) {
  const { rows: [d] } = await db.query(
    `INSERT INTO devices (hostname, serial, agent_version, source) VALUES ($1, $2, $3, 'agent') RETURNING id`,
    [hostname, serial, agentVersion])
  const { secret } = await seedAgentToken(db, { deviceId: d.id })
  return { id: d.id, secret }
}

async function checkinAudits(deviceId) {
  const { rows } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'agent_checkin' AND target = $1 ORDER BY created_at`,
    [String(deviceId)])
  return rows.map(r => r.details)
}

test('checkin de routine : aucune ligne d’audit', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-ROUTINE', serial: 'SN-AUD-R', agentVersion: '2.14.0' })
  for (let i = 0; i < 3; i++) {
    const res = await checkin(d.secret, { hostname: 'PC-AUD-ROUTINE', serial: 'SN-AUD-R', agent_version: '2.14.0' })
    assert.equal(res.statusCode, 200, res.body)
  }
  assert.deepEqual(await checkinAudits(d.id), [])
})

test('premier enrôlement (nouveau poste) : une ligne', { skip: SKIP }, async () => {
  const { secret } = await seedAgentToken(db, { deviceId: null, label: 'install-ps1' })
  const res = await checkin(secret, { hostname: 'PC-AUD-NEW', serial: 'SN-AUD-NEW', agent_version: '2.14.0' })
  assert.equal(res.statusCode, 200, res.body)
  const audits = await checkinAudits(res.json().device_id)
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].events, ['enrolled'])
  assert.equal(audits[0].new, true)
  assert.equal(audits[0].level, 'info')
})

test('poste renommé (retrouvé par son numéro de série) : une ligne avec l’ancien nom', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-OLD', serial: 'SN-AUD-REN', agentVersion: '2.14.0' })
  const res = await checkin(d.secret, { hostname: 'PC-AUD-RENAMED', serial: 'SN-AUD-REN', agent_version: '2.14.0' })
  assert.equal(res.statusCode, 200, res.body)
  const audits = await checkinAudits(d.id)
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].events, ['hostname_changed'])
  assert.equal(audits[0].previous_hostname, 'PC-AUD-OLD')
})

test('version d’agent changée (mise à jour, ou premier checkin sur un poste Intune) : une ligne', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-VER', serial: 'SN-AUD-VER', agentVersion: '2.13.0' })
  await checkin(d.secret, { hostname: 'PC-AUD-VER', serial: 'SN-AUD-VER', agent_version: '2.14.0' })
  await checkin(d.secret, { hostname: 'PC-AUD-VER', serial: 'SN-AUD-VER', agent_version: '2.14.0' })
  const audits = await checkinAudits(d.id)
  assert.equal(audits.length, 1, 'une seule ligne : au changement')
  assert.deepEqual(audits[0].events, ['agent_version_changed'])
  assert.equal(audits[0].previous_agent_version, '2.13.0')
  assert.equal(audits[0].agent_version, '2.14.0')
})

test('ip_netbird refusée : une ligne de niveau warn', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-IP', serial: 'SN-AUD-IP', agentVersion: '2.14.0' })
  await checkin(d.secret, { hostname: 'PC-AUD-IP', serial: 'SN-AUD-IP', agent_version: '2.14.0', ip_netbird: '8.8.8.8' })
  const audits = await checkinAudits(d.id)
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].events, ['ip_netbird_rejected'])
  assert.equal(audits[0].level, 'warn')
})

test('série différente de celle du poste (retrouvé par son nom) : une ligne de niveau warn', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-SN', serial: 'SN-AUD-A', agentVersion: '2.14.0' })
  await checkin(d.secret, { hostname: 'PC-AUD-SN', serial: 'SN-AUD-B', agent_version: '2.14.0' })
  const audits = await checkinAudits(d.id)
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].events, ['serial_mismatch'])
  assert.equal(audits[0].level, 'warn')
  assert.equal(audits[0].serial, 'SN-AUD-B')
  assert.equal(audits[0].device_serial, 'SN-AUD-A')
})

// ── Rétention des séries au checkin ──────────────────────────────────────────

test('checkin : séries du poste purgées au-delà de la durée de lib/retention.js', { skip: SKIP }, async () => {
  const d = await device({ hostname: 'PC-AUD-RET', serial: 'SN-AUD-RET', agentVersion: '2.14.0' })
  const cases = [
    ['bandwidth_stats', `INSERT INTO bandwidth_stats (device_id, adapter, sampled_at) VALUES ($1, 'eth0', now() - make_interval(days => $2))`],
    ['ping_stats', `INSERT INTO ping_stats (device_id, host, sampled_at) VALUES ($1, '1.1.1.1', now() - make_interval(days => $2))`],
    ['system_perf_stats', `INSERT INTO system_perf_stats (device_id, sampled_at) VALUES ($1, now() - make_interval(days => $2))`],
  ]
  for (const [table, sql] of cases) {
    await db.query(sql, [d.id, retentionDays(table) + 1])
    await db.query(sql, [d.id, retentionDays(table) - 1])
  }
  const res = await checkin(d.secret, {
    hostname: 'PC-AUD-RET', serial: 'SN-AUD-RET', agent_version: '2.14.0',
    bandwidth: [{ adapter: 'eth0', bytes_sent: 1, bytes_recv: 1 }],
    ping: [{ host: '1.1.1.1', latency_ms: 3, packet_loss_pct: 0 }],
    system_perf: { ram_used_pct: 50 },
  })
  assert.equal(res.statusCode, 200, res.body)
  // Nettoyages non bloquants (fire-and-forget) : on attend leur effet.
  const counts = (table) => db.query(`
    SELECT count(*) FILTER (WHERE sampled_at < now() - make_interval(days => $2))::int AS old,
           count(*) FILTER (WHERE sampled_at >= now() - make_interval(days => $2))::int AS kept
    FROM ${table} WHERE device_id = $1`, [d.id, retentionDays(table)]).then(r => r.rows[0])
  for (const [table] of cases) {
    let c = await counts(table)
    for (let i = 0; i < 30 && c.old > 0; i++) {
      await new Promise((r) => setTimeout(r, 100))
      c = await counts(table)
    }
    assert.equal(c.old, 0, `${table} : échantillon trop ancien purgé`)
    assert.equal(c.kept, 2, `${table} : échantillon récent + nouveau conservés`)
  }
})

test('agent.js : aucune durée de rétention en dur pour les séries (lib/retention.js fait foi)', async () => {
  const src = await fs.readFile(path.resolve(__dirname, '../../modules/inventory/routes/agent.js'), 'utf8')
  const hardcoded = src.match(/DELETE FROM (bandwidth_stats|ping_stats|system_perf_stats)[^`]*interval '\d+ days'/g) || []
  assert.deepEqual(hardcoded, [])
})
