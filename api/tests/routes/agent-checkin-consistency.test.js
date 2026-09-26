// POST /api/agent/checkin — cohérence en cas d'échec et de concurrence :
//   - l'inventaire (poste, disques, interfaces, séries) est écrit dans UNE
//     transaction : un échec en cours de route laisse l'inventaire précédent
//     intact (avant : interfaces supprimées puis partiellement réinsérées) ;
//   - scripts et déploiements sont réservés ('running') dans UNE
//     transaction : un échec de la réservation des déploiements ne laisse
//     pas de script en 'running' sans l'avoir livré ;
//   - le contenu de déploiement envoyé est lu AU MOMENT de la réservation
//     (snapshot et statut approuvé du package à cet instant) ;
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

  // Valeur refusée par Postgres (compteur non numérique pour un BIGINT) :
  // l'insertion échoue APRÈS la mise à jour du poste, des disques, la
  // suppression des anciennes interfaces et l'insertion des nouvelles.
  const bad = await checkin(fastify, secret, {
    hostname: device.hostname, os: 'Windows 11',
    disks: [{ letter: 'C:', size_gb: 256, used_pct: 95 }],
    network: [{ mac: 'CC-CC', ip: '10.0.0.3', type: 'eth' }, { mac: 'DD-DD', ip: '10.0.0.4', type: 'eth' }],
    bandwidth: [{ adapter: 'eth0', bytes_sent: 'pas-un-nombre', bytes_recv: 1 }],
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

test('octets NUL dans les chaînes remontées : retirés à l’entrée, checkin accepté (poste vu en ligne)', { skip: SKIP }, async () => {
  // Postgres refuse \u0000 dans TEXT et JSONB : sans nettoyage, une chaîne
  // corrompue côté agent faisait échouer tout le checkin (inventaire annulé,
  // last_seen compris → poste vu hors ligne).
  const device = await seedDevice(db, { hostname: 'PC-NUL' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  await db.query(`UPDATE devices SET last_seen = now() - interval '3 days' WHERE id = $1`, [device.id])
  const res = await checkin(fastify, secret, {
    hostname: 'PC-NUL', os: 'Windows\u0000 11',
    network: [{ mac: 'AA\u0000-BB', adapter: 'Ethernet\u0000', type: 'eth' }],
    system_info: { current_user: 'jdoe\u0000' },
    health: { defender: { engine: 'x\u0000' } },
  })
  assert.equal(res.statusCode, 200, res.body)
  const { rows: [dev] } = await db.query(
    `SELECT os, system_info->>'current_user' AS usr, last_seen > now() - interval '1 minute' AS fresh FROM devices WHERE id = $1`,
    [device.id])
  assert.deepEqual(dev, { os: 'Windows 11', usr: 'jdoe', fresh: true })
  const { rows: ifaces } = await db.query(`SELECT mac, adapter FROM network_interfaces WHERE device_id = $1`, [device.id])
  assert.deepEqual(ifaces, [{ mac: 'AA-BB', adapter: 'Ethernet' }])
})

test('nouveau poste : échec en plein inventaire → aucun poste à moitié créé', { skip: SKIP }, async () => {
  const { secret } = await seedAgentToken(db, { deviceId: null, label: 'install-ps1' })
  const bad = await checkin(fastify, secret, {
    hostname: 'PC-INV-NEW', serial: 'SN-INV-NEW',
    network: [{ mac: 'EE-EE', type: 'eth' }],
    bandwidth: [{ adapter: 'eth0', bytes_sent: 'pas-un-nombre' }],
  })
  assert.equal(bad.statusCode, 500)
  const { rows } = await db.query(`SELECT 1 FROM devices WHERE hostname = 'PC-INV-NEW'`)
  assert.equal(rows.length, 0)
})

// ── (b) Réservation des scripts et déploiements ──────────────────────────────

test('réservation : échec côté déploiements → scripts non réservés (pas de running orphelin)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM-TX' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const scriptId = await queueScript(device.id, 'script-claim-tx')
  const { dep } = await snapshottedDeployment(device.id, 'Pkg Claim TX', 'Write-Output tx')

  await db.query('ALTER TABLE deployments RENAME COLUMN started_at TO started_at_broken')
  let res
  try {
    res = await checkin(fastify, secret, { hostname: device.hostname })
  } finally {
    await db.query('ALTER TABLE deployments RENAME COLUMN started_at_broken TO started_at')
  }
  assert.equal(res.statusCode, 500)
  assert.equal(await statusOf('script_executions', scriptId), 'pending', 'script non consommé')
  assert.equal(await statusOf('deployments', dep.id), 'pending')

  const again = await checkin(fastify, secret, { hostname: device.hostname })
  assert.equal(again.statusCode, 200, again.body)
  assert.deepEqual(again.json().commands.map(c => c.id), [scriptId])
  assert.deepEqual(again.json().deployments.map(d => d.deployment_id), [dep.id])
})

test('contenu envoyé = snapshot au moment de la réservation (ré-approbation pendant le checkin)', { skip: SKIP }, async (t) => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM-SNAP' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep } = await snapshottedDeployment(device.id, 'Pkg Claim Snap', 'Write-Output v1')

  // Pendant le checkin (après la sélection des déploiements), un admin
  // modifie puis ré-approuve le package : le snapshot est rafraîchi.
  const app = await appWith(interleavingPool(/p\.detection_script IS NOT NULL/, () =>
    db.query(`UPDATE deployment_snapshots SET install_script = 'Write-Output v2' WHERE deployment_id = $1`, [dep.id])))
  t.after(() => app.close())

  const res = await checkin(app, secret, { hostname: device.hostname })
  assert.equal(res.statusCode, 200, res.body)
  const sent = res.json().deployments
  assert.equal(sent.length, 1)
  const { rows: [snap] } = await db.query(
    `SELECT install_script FROM deployment_snapshots WHERE deployment_id = $1`, [dep.id])
  assert.equal(sent[0].install_script, snap.install_script, 'contenu envoyé = snapshot enregistré')
  assert.equal(sent[0].install_script, 'Write-Output v2')
})

test('package repassé en draft pendant le checkin : déploiement non distribué, reste pending', { skip: SKIP }, async (t) => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM-DRAFT' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep, pkg } = await snapshottedDeployment(device.id, 'Pkg Claim Draft', 'Write-Output d')

  const app = await appWith(interleavingPool(/p\.detection_script IS NOT NULL/, () =>
    db.query(`UPDATE packages SET status = 'draft' WHERE id = $1`, [pkg.id])))
  t.after(() => app.close())

  const res = await checkin(app, secret, { hostname: device.hostname })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().deployments, [])
  assert.equal(await statusOf('deployments', dep.id), 'pending')
})

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

// ── (c) Résultat de script : jamais perdu pour une sortie trop longue ───────

test('POST /result — sortie > 10 000 caractères : résultat enregistré (tronqué), plus de 500', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-RESULT-LONG' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const scriptId = await queueScript(device.id, 'long-output')
  const got = await checkin(fastify, secret, { hostname: device.hostname })
  assert.deepEqual(got.json().commands.map(c => c.id), [scriptId])

  // script_executions.output est VARCHAR(10000) (migration 029).
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/result',
    headers: { authorization: `Bearer ${secret}` },
    payload: { execution_id: scriptId, exit_code: 0, output: 'é'.repeat(12000) + 'FIN' },
  })
  assert.equal(res.statusCode, 204, res.body)
  const { rows: [r] } = await db.query(
    `SELECT status, exit_code, length(output) AS len FROM script_executions WHERE id = $1`, [scriptId])
  assert.equal(r.status, 'done')
  assert.equal(r.exit_code, 0)
  assert.equal(r.len, 10000)
})
