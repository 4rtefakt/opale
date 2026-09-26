// POST /api/agent/checkin — fenêtre de maintenance (settings
// maintenance_window_default) :
//   - la réponse ne porte une maintenance_window que si l'agent Go peut la
//     décoder (types.go MaintenanceWindow) : un champ de mauvais type fait
//     échouer TOUT le décodage de la réponse, donc chaque checkin (et, après
//     une mise à jour, déclenche le rollback). Sinon null (décodé par tous
//     les agents : fenêtre absente) ;
//   - fenêtre configurée mais invalide : aucun déploiement réservé
//     (fail-closed, ils restent 'pending'), un avertissement par valeur ;
//     scripts inchangés. Pas de fenêtre : toujours ouverte (inchangé).

import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

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
    { start: '02:00', end: '04:00', tz: 'Mars/Olympus' }, // fuseau inconnu, mais types corrects
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

test('POST /checkin — maintenance_window : seules les clés exactes weekdays/start/end/tz sont envoyées', { skip: SKIP }, async () => {
  // encoding/json associe les clés SANS tenir compte de la casse : renvoyée
  // telle quelle, « Weekdays »:["1"] faisait échouer le décodage (chaque
  // checkin), « START » écrasait start, « Start »/« End » donnaient à
  // l'agent une fenêtre que le serveur ne voyait pas. Réponses décodées
  // telles quelles par agent-go (TestCheckinResponse_DecodesSanitizedWindow).
  const cases = [
    ['{"Weekdays":["1"],"start":"02:00","end":"04:00"}', { start: '02:00', end: '04:00' }],
    ['{"start":"02:00","end":"04:00","START":"x"}',      { start: '02:00', end: '04:00' }],
    ['{"Start":"02:00","End":"04:00"}',                  {}],
  ]
  for (const [raw, sent] of cases) {
    await setWindow(raw)
    const body = await checkinResponse()
    assert.deepEqual(body.maintenance_window, sent, `${raw} : fenêtre envoyée`)
  }
})

// ─── Fenêtre configurée mais invalide : aucun déploiement ───────────────────

// Poste avec un déploiement (package approuvé + snapshot) et un script en
// attente ; renvoie la réponse du checkin et les statuts qui en résultent.
async function checkinWithJobs() {
  const device = await seedDevice(db, { hostname: `PC-WINDOW-JOBS-${++seq}` })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertPackage(db, { name: `Pkg Window ${seq}`, type: 'script', wingetId: null })
  await db.query(`UPDATE packages SET install_script = 'Write-Output ok' WHERE id = $1`, [pkg.id])
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId: device.id })
  await db.query(`
    INSERT INTO deployment_snapshots (deployment_id, name, type, winget_id, install_script, post_install_script, detection_script)
    SELECT $1, p.name, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script
    FROM packages p WHERE p.id = $2
  `, [dep.id, pkg.id])
  const { rows: [script] } = await db.query(
    `INSERT INTO script_executions (device_id, script_name, script_content, status, mode)
     VALUES ($1, 'diag', 'hostname', 'pending', 'agent') RETURNING id`, [device.id]
  )
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload: { hostname: device.hostname, agent_version: '2.15.1' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const { rows: [d] } = await db.query(`SELECT status FROM deployments WHERE id = $1`, [dep.id])
  return { body: res.json(), dep, scriptId: script.id, depStatus: d.status }
}

test('POST /checkin — fenêtre configurée mais invalide : aucun déploiement réservé, scripts livrés', { skip: SKIP }, async () => {
  // Avant : fail-open → installations à toute heure, sans signal.
  // Valeurs absentes des tests précédents (sinon avertissement déjà émis).
  const invalid = [
    '{"start":"02:00","end":"04:00","tz":"Europe/Pari"}',
    '{"start":"2:5","end":"04:00"}',
    '{"start":"+2:00","end":"04:00"}',
    '{"start":" 02:00","end":"04:00"}',
    '{"start":"24:00","end":"04:00"}',
    '{"start":"02:00:00","end":"04:00"}',
    '{"start":"02:00"}',
    '{"weekdays":[1,7],"start":"00:00","end":"00:00"}',
    '{"weekdays":"1,2,3"}',
    '{"start":2,"end":"05:00"}',
    '"02:00-05:00"',
    '{"start":',
    // Clés hors weekdays/start/end/tz (casse, fautes de frappe) : l'agent
    // Go les lit sans tenir compte de la casse, le serveur les ignorait.
    '{"Weekdays":["1"],"start":"02:00","end":"05:00"}',
    '{"start":"02:00","end":"05:00","START":"x"}',
    '{"Start":"02:00","End":"05:00"}',
    '{"days":[1,2,3]}',
    '{"from":"02:00","to":"05:00"}',
  ]
  const warns = []
  const origWarn = fastify.log.warn
  fastify.log.warn = (...args) => { warns.push(args) }
  try {
    for (const raw of invalid) {
      await setWindow(raw)
      const { body, scriptId, depStatus } = await checkinWithJobs()
      assert.deepEqual(body.deployments, [], `${raw} : déploiement réservé malgré une fenêtre invalide`)
      assert.equal(depStatus, 'pending', `${raw} : le déploiement doit rester en attente`)
      assert.deepEqual(body.commands.map(c => c.id), [scriptId], `${raw} : scripts inchangés (livrés)`)
      // Même valeur au checkin suivant : pas de nouvel avertissement.
      await checkinWithJobs()
    }
  } finally {
    fastify.log.warn = origWarn
  }
  const windowWarns = warns.filter(a => /fenêtre de maintenance invalide/.test(String(a[1])))
  assert.equal(windowWarns.length, invalid.length, 'un avertissement par valeur invalide distincte')
})

test('POST /checkin — pas de fenêtre ou fenêtre valide ouverte : déploiement réservé (inchangé)', { skip: SKIP }, async () => {
  for (const raw of [null, '{}', 'null', '{"start":"00:00","end":"00:00","tz":"Europe/Paris"}', '{"weekdays":[0,1,2,3,4,5,6]}']) {
    if (raw === null) await db.query(`DELETE FROM settings WHERE key = 'maintenance_window_default'`)
    else await setWindow(raw)
    const { body, dep, scriptId, depStatus } = await checkinWithJobs()
    assert.deepEqual(body.deployments.map(d => d.deployment_id), [dep.id], `${raw} : déploiement attendu`)
    assert.equal(depStatus, 'running')
    assert.deepEqual(body.commands.map(c => c.id), [scriptId])
  }
})
