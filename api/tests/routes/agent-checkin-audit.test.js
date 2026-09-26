// POST /api/agent/checkin — audit : plus une ligne par checkin (≈ 10 000
// lignes / jour pour 110 postes, 365 j de rétention), seulement les
// événements significatifs : enrôlement, changement de nom, série
// différente, version d'agent changée, ip_netbird refusée. Les
// rattachements / refus de token ont leurs propres actions (inchangées).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'

import agentRoute from '../../modules/inventory/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

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
