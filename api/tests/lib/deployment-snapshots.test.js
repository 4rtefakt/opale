// Migration 071 (deployment_snapshots) : backfill des déploiements encore
// 'pending' de packages approuvés, idempotent (la CI rejoue les migrations
// deux fois, et le runbook demande de la rejouer après redémarrage de l'API).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(__dirname, '../../migrations/071_deployment_snapshots.sql')

let db, release

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

async function scriptPackage(name, status, installScript) {
  const pkg = await insertPackage(db, { name, type: 'script', wingetId: null, status })
  await db.query(`UPDATE packages SET install_script = $1 WHERE id = $2`, [installScript, pkg.id])
  return pkg
}

async function snapshot(deploymentId) {
  const { rows } = await db.query(
    'SELECT * FROM deployment_snapshots WHERE deployment_id = $1', [deploymentId]
  )
  return rows[0] || null
}

test('071 — backfill : pending de packages approuvés uniquement, idempotent', { skip: SKIP }, async () => {
  const sql = await fs.readFile(MIGRATION, 'utf8')
  const dev = await seedDevice(db, { hostname: 'PC-MIG-071' })
  const dev2 = await seedDevice(db, { hostname: 'PC-MIG-071-B' })

  const approved = await scriptPackage('Mig Approved', 'approved', 'Write-Output approved')
  const draft = await scriptPackage('Mig Draft', 'draft', 'Write-Output draft')

  // Lignes « legacy » (créées avant 071, donc sans snapshot).
  const pendingApproved = await insertDeployment(db, { packageId: approved.id, deviceId: dev.id })
  const pendingDraft = await insertDeployment(db, { packageId: draft.id, deviceId: dev.id })
  const running = await insertDeployment(db, { packageId: approved.id, deviceId: dev2.id, status: 'running' })
  // Un pending déjà figé : le backfill ne doit pas l'écraser.
  const other = await scriptPackage('Mig Already', 'approved', 'Write-Output current')
  const alreadySnap = await insertDeployment(db, { packageId: other.id, deviceId: dev2.id })
  await db.query(
    `INSERT INTO deployment_snapshots (deployment_id, name, type, install_script)
     VALUES ($1, 'Mig Already', 'script', 'Write-Output frozen')`,
    [alreadySnap.id]
  )

  await db.query(sql)

  const s = await snapshot(pendingApproved.id)
  assert.ok(s, 'pending d\'un package approuvé → snapshot créé')
  assert.equal(s.install_script, 'Write-Output approved')
  assert.equal(s.type, 'script')
  assert.equal(s.name, 'Mig Approved')
  assert.equal(await snapshot(pendingDraft.id), null, 'package draft → pas de snapshot')
  assert.equal(await snapshot(running.id), null, 'déjà running → pas de snapshot')
  assert.equal((await snapshot(alreadySnap.id)).install_script, 'Write-Output frozen')

  // Rejeu : aucune erreur, aucun changement.
  const { rows: [{ n: before }] } = await db.query('SELECT count(*)::int AS n FROM deployment_snapshots')
  await db.query(sql)
  const { rows: [{ n: afterRun }] } = await db.query('SELECT count(*)::int AS n FROM deployment_snapshots')
  assert.equal(afterRun, before)
  assert.equal((await snapshot(pendingApproved.id)).install_script, 'Write-Output approved')
})
