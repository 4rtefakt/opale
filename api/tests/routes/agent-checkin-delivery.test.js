// POST /api/agent/checkin — livraison des résultats et des travaux :
//   - un résultat de déploiement / détection peut être renvoyé (l'agent ne
//     le retire de sa file qu'après acquittement : réponse perdue → renvoi) ;
//     le serveur doit l'accepter sans effet de bord (pas de changement de
//     statut, pas de doublon, pas de 4xx/5xx qui ferait renvoyer l'agent
//     indéfiniment) ;
//   - un agent < 2.15.0 ignore la réponse du re-checkin qui remonte ses
//     résultats de déploiement : rien n'y est réservé, les travaux partent
//     au checkin suivant (un agent ≥ 2.15.0 traite cette réponse).
//     Réponse portant une mise à jour : cf. agent-checkin-update-jobs.test.js.

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

// ─── Re-checkin post-déploiement (plus d'un lot) ────────────────────────────

async function queueScript(deviceId, name) {
  const { rows: [r] } = await db.query(
    `INSERT INTO script_executions (device_id, script_name, script_content, status, mode)
     VALUES ($1, $2, 'hostname', 'pending', 'agent') RETURNING id`,
    [deviceId, name]
  )
  return r.id
}

async function statusOf(table, id) {
  const { rows: [r] } = await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])
  return r.status
}

// 11 déploiements en attente (lots de 10) : le 1er checkin en livre 10 ; le
// re-checkin qui remonte leurs résultats trouve le 11e et un script mis en
// file entre-temps. Renvoie ce que ce re-checkin a livré.
async function followUpScenario(hostname, agentVersion) {
  const device = await seedDevice(db, { hostname })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const deps = []
  for (let i = 1; i <= 11; i++) {
    deps.push((await snapshottedDeployment(device.id, `${hostname} Pkg ${i}`)).dep)
  }
  const version = agentVersion ? { agent_version: agentVersion } : {}

  const first = await checkin(secret, { hostname, ...version })
  assert.equal(first.statusCode, 200, first.body)
  const delivered = first.json().deployments.map(d => d.deployment_id)
  assert.equal(delivered.length, 10)
  const eleventh = deps.find(d => !delivered.includes(d.id))
  const scriptId = await queueScript(device.id, `${hostname} diag`)

  const followUp = await checkin(secret, {
    hostname, ...version,
    deployment_results: delivered.map(id => ({ deployment_id: id, exit_code: 0, output: 'ok' })),
  })
  assert.equal(followUp.statusCode, 200, followUp.body)
  for (const id of delivered) assert.equal(await statusOf('deployments', id), 'success')
  return { device, secret, version, eleventh, scriptId, body: followUp.json() }
}

test('POST /checkin — agent < 2.15.0 : rien n\'est réservé dans la réponse du re-checkin (ignorée), tout part au checkin suivant', { skip: SKIP }, async () => {
  // Version absente (agent qui ne la remonte pas) : traitée comme ancienne.
  for (const [hostname, agentVersion] of [['PC-FOLLOWUP-214', '2.14.0'], ['PC-FOLLOWUP-NOVER', null]]) {
    const { secret, version, eleventh, scriptId, body } = await followUpScenario(hostname, agentVersion)
    assert.deepEqual(body.deployments, [], `${hostname} : déploiement réservé dans une réponse ignorée`)
    assert.deepEqual(body.commands, [], `${hostname} : script réservé dans une réponse ignorée`)
    assert.equal(await statusOf('deployments', eleventh.id), 'pending')
    assert.equal(await statusOf('script_executions', scriptId), 'pending')

    // Checkin suivant (réponse traitée par l'agent) : livrés, une seule fois.
    const next = await checkin(secret, { hostname, ...version })
    assert.equal(next.statusCode, 200, next.body)
    assert.deepEqual(next.json().deployments.map(d => d.deployment_id), [eleventh.id])
    assert.deepEqual(next.json().commands.map(c => c.id), [scriptId])
    assert.equal(await statusOf('deployments', eleventh.id), 'running')
  }
})

test('POST /checkin — agent ≥ 2.15.0 : le re-checkin réserve le lot suivant (réponse traitée)', { skip: SKIP }, async () => {
  const { eleventh, scriptId, body } = await followUpScenario('PC-FOLLOWUP-215', '2.15.0')
  assert.deepEqual(body.deployments.map(d => d.deployment_id), [eleventh.id])
  assert.deepEqual(body.commands.map(c => c.id), [scriptId])
  assert.equal(await statusOf('deployments', eleventh.id), 'running')
})
