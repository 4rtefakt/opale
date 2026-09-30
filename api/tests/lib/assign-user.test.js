// inventory/lib/assign-user.js : seul écrivain manuel de devices.assigned_user_id,
// toutes plateformes, validé sur users_cache et audité avec avant / après.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { setAssignedUser } from '../../modules/inventory/lib/assign-user.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  await seedNonAdmin(db, { entraId: 'oid-alice', displayName: 'Alice' })
  await seedAdmin(db, { entraId: 'oid-bob', displayName: 'Bob' })
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

test('setAssignedUser — assigne, réassigne, désassigne ; audit device_assigned avec avant / après', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-ASSIGN' })
  const first = await setAssignedUser(db, null, 'Admin', device.id, 'oid-alice')
  assert.deepEqual(first, { ok: true, id: device.id, assigned_user_id: 'oid-alice', assigned_user_name: 'Alice' })
  const second = await setAssignedUser(db, null, 'Admin', device.id, 'oid-bob')
  assert.equal(second.assigned_user_name, 'Bob')
  const cleared = await setAssignedUser(db, null, 'Admin', device.id, null)
  assert.deepEqual(cleared, { ok: true, id: device.id, assigned_user_id: null, assigned_user_name: null })
  const { rows: [row] } = await db.query('SELECT assigned_user_id FROM devices WHERE id = $1', [device.id])
  assert.equal(row.assigned_user_id, null)
  const { rows } = await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'device_assigned' AND target = $1 ORDER BY created_at, id", [device.id])
  assert.deepEqual(rows.map(r => r.details), [
    { before: null, after: 'oid-alice' }, { before: 'oid-alice', after: 'oid-bob' }, { before: 'oid-bob', after: null },
  ])
  assert.equal(rows[0].by_user, 'Admin')
})

test('setAssignedUser — utilisateur inconnu : 400 sans mutation ; poste inconnu : 404', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-ASSIGN-KO' })
  await setAssignedUser(db, null, 'Admin', device.id, 'oid-alice')
  const unknown = await setAssignedUser(db, null, 'Admin', device.id, 'oid-nobody')
  assert.deepEqual(unknown, { ok: false, status: 400, code: 'UNKNOWN_USER' })
  const { rows: [row] } = await db.query('SELECT assigned_user_id FROM devices WHERE id = $1', [device.id])
  assert.equal(row.assigned_user_id, 'oid-alice')
  const missing = await setAssignedUser(db, null, 'Admin', '00000000-0000-4000-8000-000000000000', 'oid-alice')
  assert.deepEqual(missing, { ok: false, status: 404, code: 'NOT_FOUND' })
  const { rows: audits } = await db.query("SELECT 1 FROM audit_logs WHERE action = 'device_assigned' AND target = $1", [device.id])
  assert.equal(audits.length, 1, 'aucun audit pour un refus')
})
