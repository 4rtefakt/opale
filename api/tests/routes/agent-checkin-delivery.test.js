// POST /api/agent/checkin — livraison des résultats et des travaux :
//   - un résultat de déploiement / détection peut être renvoyé (l'agent ne
//     le retire de sa file qu'après acquittement : réponse perdue → renvoi) ;
//     le serveur doit l'accepter sans effet de bord (pas de changement de
//     statut, pas de doublon, pas de 4xx/5xx qui ferait renvoyer l'agent
//     indéfiniment) ;
//   - un agent < 2.15.1 ignore la réponse du re-checkin qui remonte ses
//     résultats de déploiement : rien n'y est réservé, les travaux partent
//     au checkin suivant (un agent ≥ 2.15.1 traite cette réponse).
//     Réponse portant une mise à jour : cf. agent-checkin-update-jobs.test.js ;
//   - détection post-install : le déploiement envoyé porte son package_id ;
//     un agent ≤ 2.14 qui remonte le deployment_id à sa place voit sa
//     détection rattachée au package de ce déploiement (de CE poste).

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

test('POST /checkin — agent < 2.15.1 : rien n\'est réservé dans la réponse du re-checkin (ignorée), tout part au checkin suivant', { skip: SKIP }, async () => {
  // 2.15.0 : build de main antérieur au correctif (même comportement que
  // 2.14). Version absente (agent qui ne la remonte pas) : traitée comme
  // ancienne.
  const cases = [['PC-FOLLOWUP-214', '2.14.0'], ['PC-FOLLOWUP-2150', '2.15.0'], ['PC-FOLLOWUP-NOVER', null]]
  for (const [hostname, agentVersion] of cases) {
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

test('POST /checkin — agent ≥ 2.15.1 : le re-checkin réserve le lot suivant (réponse traitée)', { skip: SKIP }, async () => {
  const { eleventh, scriptId, body } = await followUpScenario('PC-FOLLOWUP-2151', '2.15.1')
  assert.deepEqual(body.deployments.map(d => d.deployment_id), [eleventh.id])
  assert.deepEqual(body.commands.map(c => c.id), [scriptId])
  assert.equal(await statusOf('deployments', eleventh.id), 'running')
})

test('POST /checkin — version non strictement X.Y.Z (rc, x, espace…) : traitée comme un ancien agent', { skip: SKIP }, async () => {
  // Une partie non numérique valait 0 : « 2.16.0-rc1 » ou « 2.16 » passaient
  // pour ≥ 2.15.1. Dans le doute, rien n'est réservé dans une réponse que
  // l'agent pourrait ignorer (les travaux attendent un checkin sans résultat).
  const followUpOf = (hostname, agent_version) => ({
    hostname, agent_version,
    deployment_results: [{ deployment_id: '00000000-0000-4000-8000-000000000000', exit_code: 0 }],
  })
  const versions = ['2.16.0-rc1', '2.16.x', ' 2.16.0', '2.16', 'v2.16.0', '2.16.0.1']
  for (const [i, version] of versions.entries()) {
    const device = await seedDevice(db, { hostname: `PC-SEMVER-${i}` })
    const { secret } = await seedAgentToken(db, { deviceId: device.id })
    const { dep } = await snapshottedDeployment(device.id, `Pkg Semver ${i}`)
    const res = await checkin(secret, followUpOf(device.hostname, version))
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().deployments, [], `« ${version} » : déploiement réservé dans une réponse peut-être ignorée`)
    assert.equal(await statusOf('deployments', dep.id), 'pending')
  }
  // Témoin : version stricte ≥ 2.15.1.
  const device = await seedDevice(db, { hostname: 'PC-SEMVER-STRICT' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep } = await snapshottedDeployment(device.id, 'Pkg Semver Strict')
  const res = await checkin(secret, followUpOf(device.hostname, '2.16.0'))
  assert.deepEqual(res.json().deployments.map(d => d.deployment_id), [dep.id])
})

// ─── Détection post-install : package_id ────────────────────────────────────

async function softwareRows(deviceId) {
  const { rows } = await db.query(
    `SELECT package_id, detected FROM device_software WHERE device_id = $1 ORDER BY package_id`, [deviceId]
  )
  return rows
}

test('POST /checkin — déploiement livré avec le package_id de son package (distinct du deployment_id)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-PKGID' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep, pkg } = await snapshottedDeployment(device.id, 'Pkg PkgId', { detectionScript: 'exit 0' })
  assert.notEqual(dep.id, pkg.id)

  const res = await checkin(secret, { hostname: device.hostname })
  assert.equal(res.statusCode, 200, res.body)
  const [sent] = res.json().deployments
  assert.equal(sent.deployment_id, dep.id)
  assert.equal(sent.package_id, pkg.id)

  // Agent ≥ 2.15.1 : détection post-install remontée avec ce package_id.
  const ack = await checkin(secret, {
    hostname: device.hostname, agent_version: '2.15.1',
    deployment_results: [{ deployment_id: dep.id, exit_code: 0, output: 'ok' }],
    detection_results:  [{ package_id: sent.package_id, detected: true }],
  })
  assert.equal(ack.statusCode, 200, ack.body)
  assert.deepEqual(await softwareRows(device.id), [{ package_id: pkg.id, detected: true }])
})

test('POST /checkin — détection post-install d\'un agent ≤ 2.14 (deployment_id en package_id) : rattachée au package du déploiement du poste', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-PKGID-LEGACY' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep, pkg } = await snapshottedDeployment(device.id, 'Pkg PkgId Legacy', { detectionScript: 'exit 0' })
  // Déploiement d'un AUTRE poste : son id ne doit rien rattacher ici.
  const other = await seedDevice(db, { hostname: 'PC-PKGID-OTHER' })
  const { dep: otherDep } = await snapshottedDeployment(other.id, 'Pkg PkgId Other', { detectionScript: 'exit 0' })
  await checkin(secret, { hostname: device.hostname, agent_version: '2.14.0' })

  const res = await checkin(secret, {
    hostname: device.hostname, agent_version: '2.14.0',
    deployment_results: [{ deployment_id: dep.id, exit_code: 0, output: 'ok' }],
    detection_results:  [
      { package_id: dep.id, detected: true },
      { package_id: otherDep.id, detected: true },
    ],
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(await softwareRows(device.id), [{ package_id: pkg.id, detected: true }])
  assert.deepEqual(await softwareRows(other.id), [])
})

// ─── Jeton de réservation (claim_token) ─────────────────────────────────────

// Comme le timeout de plugins/cleanup.js puis POST /api/deployments/:id/retry :
// la MÊME ligne repasse en 'pending' (nouvelle tentative).
async function timeoutThenRetry(depId) {
  await db.query(`UPDATE deployments SET status = 'failed', completed_at = now() WHERE id = $1`, [depId])
  await db.query(`
    UPDATE deployments SET status = 'pending', exit_code = NULL, output = NULL,
           queued_at = now(), started_at = NULL, completed_at = NULL
    WHERE id = $1`, [depId])
}

test('POST /checkin — résultat d\'une tentative précédente (claim_token périmé) : ignoré, la tentative en cours garde son verdict', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep } = await snapshottedDeployment(device.id, 'Pkg Claim')
  const agent = { hostname: device.hostname, agent_version: '2.15.1' }

  const first = await checkin(secret, agent)
  const token1 = first.json().deployments[0].claim_token
  assert.equal(typeof token1, 'string', 'claim_token livré avec le déploiement')

  // Résultat de la 1re tentative retardé (réseau) : timeout, puis « Rejouer ».
  await timeoutThenRetry(dep.id)
  const second = await checkin(secret, agent)
  const token2 = second.json().deployments[0].claim_token
  assert.equal(second.json().deployments[0].deployment_id, dep.id)
  assert.notEqual(token2, token1)

  // L'ancien résultat arrive enfin : il ne doit pas trancher la 2e tentative.
  const stale = await checkin(secret, {
    ...agent,
    deployment_results: [{ deployment_id: dep.id, claim_token: token1, exit_code: 1, output: '1re tentative' }],
  })
  assert.equal(stale.statusCode, 200, stale.body)
  assert.equal(await statusOf('deployments', dep.id), 'running', 'verdict de la 2e tentative écrasé par un résultat périmé')

  const fresh = await checkin(secret, {
    ...agent,
    deployment_results: [{ deployment_id: dep.id, claim_token: token2, exit_code: 0, output: '2e tentative' }],
  })
  assert.equal(fresh.statusCode, 200, fresh.body)
  const row = await deploymentRow(dep.id)
  assert.equal(row.status, 'success')
  assert.equal(row.output, '2e tentative')
})

test('POST /checkin — résultat sans claim_token (agent ≤ 2.15.0) ou jeton illisible : comportement inchangé', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-CLAIM-LEGACY' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const { dep: a } = await snapshottedDeployment(device.id, 'Pkg Claim Legacy A')
  const { dep: b } = await snapshottedDeployment(device.id, 'Pkg Claim Legacy B')
  await checkin(secret, { hostname: device.hostname, agent_version: '2.14.0' })

  const res = await checkin(secret, {
    hostname: device.hostname, agent_version: '2.14.0',
    deployment_results: [
      { deployment_id: a.id, exit_code: 0, output: 'ok' },
      { deployment_id: b.id, claim_token: 'pas-un-jeton', exit_code: 0, output: 'ok' },
    ],
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(await statusOf('deployments', a.id), 'success')
  assert.equal(await statusOf('deployments', b.id), 'success')
})
