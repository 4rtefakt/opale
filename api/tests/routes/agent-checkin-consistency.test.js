// POST /api/agent/checkin — cohérence en cas d'échec et de concurrence :
//   - l'inventaire (poste, disques, interfaces, séries) est écrit dans UNE
//     transaction : un échec en cours de route laisse l'inventaire précédent
//     intact (avant : interfaces supprimées puis partiellement réinsérées) ;
//   - des checkins concurrents du même poste livrent chaque ligne une fois.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

import agentRoute from '../../modules/inventory/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify

async function appWith(pool) {
  return buildApp({
    db: pool,
    registerAuth: false,
    routes: async (f) => { await f.register(agentRoute, { prefix: '/api/agent' }) },
  })
}

before(async () => {
  if (!isDbAvailable()) return
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  fastify = await appWith(db)
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

function checkin(app, secret, payload) {
  return app.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload,
  })
}

async function queueScript(deviceId, name) {
  const { rows: [r] } = await db.query(
    `INSERT INTO script_executions (device_id, script_name, script_content, status, mode)
     VALUES ($1, $2, 'Write-Output hello', 'pending', 'agent') RETURNING id`,
    [deviceId, name]
  )
  return r.id
}

async function snapshottedDeployment(deviceId, name, installScript) {
  const pkg = await insertPackage(db, { name, type: 'script', wingetId: null })
  await db.query(`UPDATE packages SET install_script = $1 WHERE id = $2`, [installScript, pkg.id])
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId })
  await db.query(`
    INSERT INTO deployment_snapshots (deployment_id, name, type, winget_id, install_script, post_install_script, detection_script)
    SELECT $1, p.name, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script
    FROM packages p WHERE p.id = $2
  `, [dep.id, pkg.id])
  return { dep, pkg }
}

async function statusOf(table, id) {
  const { rows: [r] } = await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])
  return r.status
}

// Pool qui exécute `hook` juste avant la première requête correspondant à
// `pattern` : simule une action concurrente (admin) au milieu d'un checkin.
function interleavingPool(pattern, hook) {
  let fired = false
  return {
    query: async (text, params) => {
      const sql = typeof text === 'string' ? text : text.text
      if (!fired && pattern.test(sql)) { fired = true; await hook() }
      return db.query(text, params)
    },
    connect: () => db.connect(),
  }
}

// ── (a) Inventaire transactionnel ────────────────────────────────────────────

test('échec en plein inventaire : poste, disques et interfaces précédents intacts', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-INV-TX' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })

  const first = await checkin(fastify, secret, {
    hostname: device.hostname, os: 'Windows 10',
    disks: [{ letter: 'C:', size_gb: 256, used_pct: 40 }],
    network: [{ mac: 'AA-AA', ip: '10.0.0.1', type: 'eth' }, { mac: 'BB-BB', ip: '10.0.0.2', type: 'wifi' }],
  })
  assert.equal(first.statusCode, 200, first.body)

  // 2e interface invalide pour Postgres (octet NUL) : l'insertion échoue
  // APRÈS la mise à jour du poste, des disques et la suppression des
  // anciennes interfaces.
  const bad = await checkin(fastify, secret, {
    hostname: device.hostname, os: 'Windows 11',
    disks: [{ letter: 'C:', size_gb: 256, used_pct: 95 }],
    network: [{ mac: 'CC-CC', ip: '10.0.0.3', type: 'eth' }, { mac: 'DD-\u0000', ip: '10.0.0.4', type: 'eth' }],
  })
  assert.equal(bad.statusCode, 500)

  const { rows: ifaces } = await db.query(
    `SELECT mac FROM network_interfaces WHERE device_id = $1 ORDER BY mac`, [device.id])
  assert.deepEqual(ifaces.map(r => r.mac), ['AA-AA', 'BB-BB'], 'interfaces précédentes conservées')
  const { rows: [disk] } = await db.query(
    `SELECT used_pct FROM disks WHERE device_id = $1 AND letter = 'C:'`, [device.id])
  assert.equal(Number(disk.used_pct), 40, 'disque inchangé')
  const { rows: [dev] } = await db.query(`SELECT os, disk_used_pct FROM devices WHERE id = $1`, [device.id])
  assert.equal(dev.os, 'Windows 10', 'poste inchangé')
  assert.equal(Number(dev.disk_used_pct), 40)
})

test('nouveau poste : échec en plein inventaire → aucun poste à moitié créé', { skip: SKIP }, async () => {
  const { secret } = await seedAgentToken(db, { deviceId: null, label: 'install-ps1' })
  const bad = await checkin(fastify, secret, {
    hostname: 'PC-INV-NEW', serial: 'SN-INV-NEW',
    network: [{ mac: 'EE-\u0000', type: 'eth' }],
  })
  assert.equal(bad.statusCode, 500)
  const { rows } = await db.query(`SELECT 1 FROM devices WHERE hostname = 'PC-INV-NEW'`)
  assert.equal(rows.length, 0)
})

// ── (b) Réservation des scripts et déploiements ──────────────────────────────

test('checkins concurrents du même poste : chaque script / déploiement livré une seule fois', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM-RACE' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const scripts = [
    await queueScript(device.id, 'race-1'),
    await queueScript(device.id, 'race-2'),
    await queueScript(device.id, 'race-3'),
  ]
  const deps = [
    (await snapshottedDeployment(device.id, 'Pkg Race 1', 'Write-Output r1')).dep.id,
    (await snapshottedDeployment(device.id, 'Pkg Race 2', 'Write-Output r2')).dep.id,
  ]

  const responses = await Promise.all(Array.from({ length: 4 }, () =>
    checkin(fastify, secret, { hostname: device.hostname })))
  for (const r of responses) assert.equal(r.statusCode, 200, r.body)

  const sentScripts = responses.flatMap(r => r.json().commands.map(c => c.id))
  const sentDeps = responses.flatMap(r => r.json().deployments.map(d => d.deployment_id))
  assert.deepEqual([...sentScripts].sort(), [...scripts].sort(), 'chaque script une fois')
  assert.deepEqual([...sentDeps].sort(), [...deps].sort(), 'chaque déploiement une fois')
})
