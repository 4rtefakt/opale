// POST /api/agent/checkin en mode dégradé (schéma dédié à cette suite) :
//   1. migration 071 pas encore appliquée (table deployment_snapshots
//      absente) : le checkin doit aboutir (200), ne distribuer AUCUN
//      déploiement (jamais de repli sur le contenu courant de `packages`),
//      et livrer quand même les scripts en attente ;
//   2. une étape du checkin lève après la sélection des scripts : les
//      scripts ne doivent pas rester bloqués en 'running' sans avoir été
//      livrés (aucun timeout ne les rattrape).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage, insertDeployment, insertDeploymentJob } from '../fixtures/packages.js'

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
    routes: async (f) => {
      await f.register(agentRoute, { prefix: '/api/agent' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

async function queueScript(deviceId, name) {
  const { rows: [r] } = await db.query(
    `INSERT INTO script_executions (device_id, script_name, script_content, status, mode)
     VALUES ($1, $2, 'Write-Output hello', 'pending', 'agent') RETURNING id`,
    [deviceId, name]
  )
  return r.id
}

async function statusOf(table, id) {
  const { rows: [r] } = await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])
  return r.status
}

test('checkin sans la table deployment_snapshots (071 non appliquée) → 200, aucun déploiement, script livré', { skip: SKIP }, async () => {
  await db.query('DROP TABLE deployment_snapshots')

  const device = await seedDevice(db, { hostname: 'PC-NO-071' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertPackage(db, { name: 'Pkg No 071', type: 'script', wingetId: null })
  await db.query(`UPDATE packages SET install_script = 'Write-Output live' WHERE id = $1`, [pkg.id])
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId: device.id })
  const jobPkg = await insertPackage(db, { name: 'Pkg No 071 Job' })
  await insertDeploymentJob(db, { packageId: jobPkg.id, scope: 'all' })
  const scriptId = await queueScript(device.id, 'script-no-071')

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const body = res.json()
  assert.deepEqual(body.deployments, [], 'aucun déploiement, jamais le contenu courant de packages')
  assert.deepEqual(body.commands.map(c => c.id), [scriptId])

  assert.equal(await statusOf('deployments', dep.id), 'pending')
  assert.equal(await statusOf('script_executions', scriptId), 'running')
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM deployments WHERE device_id = $1 AND package_id = $2`,
    [device.id, jobPkg.id]
  )
  assert.equal(n, 0, 'fan-out du job non matérialisé sans snapshot')
})

test('checkin qui échoue après la sélection des scripts → 500, script toujours pending (redonné au prochain checkin)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-CHECKIN-FAIL' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const scriptId = await queueScript(device.id, 'script-not-stranded')

  // Panne simulée d'une étape postérieure (autre que 42P01) : elle doit
  // remonter en 500, sans avoir « consommé » le script.
  await db.query('ALTER TABLE deployment_jobs RENAME COLUMN scope TO scope_broken')
  let res
  try {
    res = await fastify.inject({
      method: 'POST', url: '/api/agent/checkin',
      headers: { authorization: `Bearer ${secret}` },
      payload: { hostname: device.hostname },
    })
  } finally {
    await db.query('ALTER TABLE deployment_jobs RENAME COLUMN scope_broken TO scope')
  }
  assert.equal(res.statusCode, 500)
  assert.equal(await statusOf('script_executions', scriptId), 'pending')

  // Checkin suivant : le script est livré.
  const again = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}` },
    payload: { hostname: device.hostname },
  })
  assert.equal(again.statusCode, 200, `body: ${again.body}`)
  assert.deepEqual(again.json().commands.map(c => c.id), [scriptId])
  assert.equal(await statusOf('script_executions', scriptId), 'running')
})
