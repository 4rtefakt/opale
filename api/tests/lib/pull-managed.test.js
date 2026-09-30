// inventory/lib/pull-managed.js : prédicat SQL et helpers des points de
// passage (refus sur un poste, filtre sur un lot).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { isPullManaged, filterPullManaged, NOT_PULL_MANAGED_SQL } from '../../modules/inventory/lib/pull-managed.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

test('isPullManaged / filterPullManaged — poste pull, legacy (NULL), inconnu', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-pull', platform: 'linux', managed_by: 'pull' })
  const legacy = await seedDevice(db, { hostname: 'PC-LEGACY' })
  const missing = '00000000-0000-4000-8000-000000000000'
  assert.equal(await isPullManaged(db, pull.id), true)
  assert.equal(await isPullManaged(db, legacy.id), false)
  assert.equal(await isPullManaged(db, missing), false)
  assert.deepEqual(await filterPullManaged(db, [pull.id, legacy.id, missing, pull.id]), { kept: [legacy.id], skipped: 3 })
  assert.deepEqual(await filterPullManaged(db, []), { kept: [], skipped: 0 })
  // Le prédicat garde les NULL (postes legacy) : IS DISTINCT FROM, pas <>.
  const { rows } = await db.query(`SELECT hostname FROM devices WHERE ${NOT_PULL_MANAGED_SQL} ORDER BY hostname`)
  assert.deepEqual(rows.map(r => r.hostname), ['PC-LEGACY'])
})
