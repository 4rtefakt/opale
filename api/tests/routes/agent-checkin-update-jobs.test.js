// POST /api/agent/checkin — réponse qui propose une mise à jour d'agent :
//   - agent < 2.15.0 : il retourne sans traiter les commandes ni les
//     déploiements de cette réponse (mise à jour réussie ou non) : rien n'y
//     est réservé, les travaux restent 'pending' pour un checkin suivant ;
//   - agent ≥ 2.15.0 : il exécute les travaux puis applique la mise à jour :
//     réservation normale.
//
// Binaire et clé de signature jetables (dossier temporaire, AGENT_GO_DIR) :
// jamais agent-go/keys ni agent-go/dist du dépôt.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SERVED_VERSION = '2.16.0'

let db, release, fastify, tmpDir

before(async () => {
  if (!isDbAvailable()) return
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opale-agent-update-'))
  fs.mkdirSync(path.join(tmpDir, 'dist'))
  fs.writeFileSync(path.join(tmpDir, 'dist', 'opale-agent-go-amd64.exe'), crypto.randomBytes(256))
  fs.writeFileSync(path.join(tmpDir, 'dist', 'agent-version.txt'), SERVED_VERSION)
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const keyPath = path.join(tmpDir, 'signing.key')
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  // Lus au chargement du module de routes : à poser avant l'import.
  process.env.AGENT_GO_DIR = tmpDir
  process.env.AGENT_GO_VERSION_FILE = path.join(tmpDir, 'dist', 'agent-version.txt')
  process.env.AGENT_SIGNING_KEY = keyPath
  const { default: agentRoute } = await import('../../modules/inventory/routes/agent.js')

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
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

function goAgentCheckin(secret, hostname, version) {
  return fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: {
      authorization: `Bearer ${secret}`,
      'user-agent': `opale-agent-go/${version} (windows/amd64)`,
    },
    payload: { hostname, agent_version: version },
  })
}

// Poste avec un déploiement (package approuvé + snapshot) et un script en
// attente.
async function deviceWithJobs(hostname) {
  const device = await seedDevice(db, { hostname })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertPackage(db, { name: `${hostname} Pkg`, type: 'script', wingetId: null })
  await db.query(`UPDATE packages SET install_script = 'Write-Output ok' WHERE id = $1`, [pkg.id])
  const dep = await insertDeployment(db, { packageId: pkg.id, deviceId: device.id })
  await db.query(`
    INSERT INTO deployment_snapshots (deployment_id, name, type, winget_id, install_script, post_install_script, detection_script)
    SELECT $1, p.name, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script
    FROM packages p WHERE p.id = $2
  `, [dep.id, pkg.id])
  const { rows: [script] } = await db.query(
    `INSERT INTO script_executions (device_id, script_name, script_content, status, mode)
     VALUES ($1, 'diag', 'hostname', 'pending', 'agent') RETURNING id`,
    [device.id]
  )
  return { device, secret, dep, scriptId: script.id }
}

async function statusOf(table, id) {
  const { rows: [r] } = await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])
  return r.status
}

test('POST /checkin — mise à jour proposée à un agent < 2.15.0 : aucun travail réservé dans cette réponse', { skip: SKIP }, async () => {
  const { device, secret, dep, scriptId } = await deviceWithJobs('PC-UPD-214')

  const res = await goAgentCheckin(secret, device.hostname, '2.14.0')
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.agent_update?.latest_version, SERVED_VERSION, 'mise à jour proposée')
  assert.deepEqual(body.deployments, [], 'déploiement réservé dans une réponse que l\'agent ignore')
  assert.deepEqual(body.commands, [], 'script réservé dans une réponse que l\'agent ignore')
  assert.equal(await statusOf('deployments', dep.id), 'pending')
  assert.equal(await statusOf('script_executions', scriptId), 'pending')

  // Agent à jour (après redémarrage) : plus de mise à jour, travaux livrés.
  const after = await goAgentCheckin(secret, device.hostname, SERVED_VERSION)
  assert.equal(after.statusCode, 200, after.body)
  assert.equal(after.json().agent_update, null)
  assert.deepEqual(after.json().deployments.map(d => d.deployment_id), [dep.id])
  assert.deepEqual(after.json().commands.map(c => c.id), [scriptId])
})

test('POST /checkin — mise à jour proposée à un agent ≥ 2.15.0 : travaux réservés avec la mise à jour', { skip: SKIP }, async () => {
  const { device, secret, dep, scriptId } = await deviceWithJobs('PC-UPD-215')

  const res = await goAgentCheckin(secret, device.hostname, '2.15.0')
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.agent_update?.latest_version, SERVED_VERSION)
  assert.deepEqual(body.deployments.map(d => d.deployment_id), [dep.id])
  assert.deepEqual(body.commands.map(c => c.id), [scriptId])
  assert.equal(await statusOf('deployments', dep.id), 'running')
})
