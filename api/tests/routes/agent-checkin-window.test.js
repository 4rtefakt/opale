// POST /api/agent/checkin — fenêtre de maintenance (settings
// maintenance_window_default) :
//   - la réponse ne porte une maintenance_window que si l'agent Go peut la
//     décoder (types.go MaintenanceWindow) : un champ de mauvais type fait
//     échouer TOUT le décodage de la réponse, donc chaque checkin (et, après
//     une mise à jour, déclenche le rollback). Sinon null (décodé par tous
//     les agents : fenêtre absente).

import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
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

afterEach(async () => {
  if (db) await db.query(`DELETE FROM settings WHERE key = 'maintenance_window_default'`)
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

async function setWindow(raw) {
  await db.query(`
    INSERT INTO settings (key, value) VALUES ('maintenance_window_default', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [raw])
}

let seq = 0
async function checkinResponse() {
  const device = await seedDevice(db, { hostname: `PC-WINDOW-${++seq}` })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload: { hostname: device.hostname, agent_version: '2.15.1' },
  })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

test('POST /checkin — maintenance_window de types incompatibles avec l\'agent Go : null dans la réponse', { skip: SKIP }, async () => {
  const undecodable = [
    '{"start":2,"end":"04:00"}',
    '{"start":"02:00","end":"04:00","tz":true}',
    '{"weekdays":"1,2"}',
    '{"weekdays":[1.5]}',
    '{"weekdays":[1,null]}',
    '{"weekdays":[4294967296]}',
    '"02:00-04:00"',
    '[1,2]',
    '{',
  ]
  for (const raw of undecodable) {
    await setWindow(raw)
    const body = await checkinResponse()
    assert.equal(body.maintenance_window, null, `${raw} : fenêtre indécodable envoyée à l'agent`)
  }
})

test('POST /checkin — maintenance_window décodable : transmise telle quelle', { skip: SKIP }, async () => {
  const decodable = [
    { weekdays: [1, 2, 3, 4, 5], start: '02:00', end: '04:00', tz: 'Europe/Paris' },
    { start: '02:00', end: '04:00', tz: 'Europe/Pari' }, // fuseau inconnu, mais types corrects
    { start: null, weekdays: null },
    {},
  ]
  for (const w of decodable) {
    await setWindow(JSON.stringify(w))
    const body = await checkinResponse()
    assert.deepEqual(body.maintenance_window, w)
  }
  // Pas de fenêtre configurée : null, comme avant.
  await db.query(`DELETE FROM settings WHERE key = 'maintenance_window_default'`)
  assert.equal((await checkinResponse()).maintenance_window, null)
})
