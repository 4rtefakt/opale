// POST /api/agent/checkin — livraison des résultats et des travaux :
//   - un résultat de déploiement / détection peut être renvoyé (l'agent ne
//     le retire de sa file qu'après acquittement : réponse perdue → renvoi) ;
//     le serveur doit l'accepter sans effet de bord (pas de changement de
//     statut, pas de doublon, pas de 4xx/5xx qui ferait renvoyer l'agent
//     indéfiniment).

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

function checkin(secret, payload, headers = {}) {
  return fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: { authorization: `Bearer ${secret}`, ...headers },
    payload,
  })
}

// Package script approuvé + déploiement pending avec son snapshot (comme
// POST /api/packages/:id/deploy, cf. lib/deployment-snapshots.js).
async function snapshottedDeployment(deviceId, name, { detectionScript = null } = {}) {
  const pkg = await insertPackage(db, { name, type: 'script', wingetId: null })
  await db.query(
    `UPDATE packages SET install_script = 'Write-Output ok', detection_script = $1 WHERE id = $2`,
    [detectionScript, pkg.id]
  )
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId })
  await db.query(`
    INSERT INTO deployment_snapshots (deployment_id, name, type, winget_id, install_script, post_install_script, detection_script)
    SELECT $1, p.name, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script
    FROM packages p WHERE p.id = $2
  `, [dep.id, pkg.id])
  return { dep, pkg }
}

async function deploymentRow(id) {
  const { rows: [r] } = await db.query(
    `SELECT status, exit_code, output, completed_at FROM deployments WHERE id = $1`, [id]
  )
  return r
}

// logAudit('package_deployed') est lancé sans await : on attend qu'il
// apparaisse (ou que le délai expire) avant de compter.
async function deployedAuditCount(depId, { atLeast = 0 } = {}) {
  const deadline = Date.now() + 2000
  for (;;) {
    const { rows: [r] } = await db.query(
      `SELECT count(*)::int AS n FROM audit_logs
       WHERE action = 'package_deployed' AND details->>'deployment_id' = $1`, [depId]
    )
    if (r.n >= atLeast || Date.now() > deadline) return r.n
    await new Promise(res => setTimeout(res, 20))
  }
}

// ─── Résultats renvoyés (idempotence) ───────────────────────────────────────

test('POST /checkin — résultat de déploiement et de détection renvoyés : 200, aucun effet de bord', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-RESEND' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep, pkg } = await snapshottedDeployment(device.id, 'Pkg Resend')

  const first = await checkin(secret, { hostname: device.hostname })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(first.json().deployments.map(d => d.deployment_id), [dep.id])

  const results = {
    hostname: device.hostname,
    deployment_results: [{ deployment_id: dep.id, exit_code: 0, output: 'installé' }],
    detection_results:  [{ package_id: pkg.id, detected: true }],
  }
  const ack = await checkin(secret, results)
  assert.equal(ack.statusCode, 200, ack.body)
  const done = await deploymentRow(dep.id)
  assert.equal(done.status, 'success')
  assert.equal(await deployedAuditCount(dep.id, { atLeast: 1 }), 1)

  // Réponse perdue côté agent : mêmes résultats renvoyés au checkin suivant.
  const resend = await checkin(secret, results)
  assert.equal(resend.statusCode, 200, resend.body)
  const again = await deploymentRow(dep.id)
  assert.deepEqual(again, done, 'ligne de déploiement inchangée par le renvoi')
  await new Promise(res => setTimeout(res, 100))
  assert.equal(await deployedAuditCount(dep.id), 1, 'pas de second audit package_deployed')

  const { rows: sw } = await db.query(
    `SELECT detected FROM device_software WHERE device_id = $1 AND package_id = $2`, [device.id, pkg.id]
  )
  assert.deepEqual(sw, [{ detected: true }], 'une seule ligne device_software')
})

test('POST /checkin — résultat renvoyé après un autre verdict : le premier reçu fait foi', { skip: SKIP }, async () => {
  // Le statut n'est posé qu'une fois (ligne 'running') : un renvoi, même
  // avec un contenu différent, ne fait jamais basculer un verdict déjà reçu.
  const device = await seedDevice(db, { hostname: 'PC-RESEND-FLIP' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep } = await snapshottedDeployment(device.id, 'Pkg Resend Flip')
  await checkin(secret, { hostname: device.hostname })

  await checkin(secret, {
    hostname: device.hostname,
    deployment_results: [{ deployment_id: dep.id, exit_code: 1, output: 'échec' }],
  })
  const failed = await deploymentRow(dep.id)
  assert.equal(failed.status, 'failed')

  const res = await checkin(secret, {
    hostname: device.hostname,
    deployment_results: [{ deployment_id: dep.id, exit_code: 0, output: 'ok' }],
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(await deploymentRow(dep.id), failed)
})

test('POST /checkin — résultats inconnus ou mal formés : 200 (jamais renvoyés en boucle)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-RESEND-BAD' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const res = await checkin(secret, {
    hostname: device.hostname,
    deployment_results: [
      { deployment_id: '00000000-0000-4000-8000-000000000000', exit_code: 0, output: 'x' },
      { deployment_id: 'pas-un-uuid', exit_code: 0 },
    ],
    detection_results: [
      { package_id: '00000000-0000-4000-8000-000000000000', detected: true },
      { package_id: 'pas-un-uuid', detected: false },
    ],
  })
  assert.equal(res.statusCode, 200, res.body)
})
