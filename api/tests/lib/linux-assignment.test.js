// lib/assignment.js : changement de profil / ring d'un poste pull (avant/après
// audités seulement quand quelque chose change) et lot par ids ou groupe natif.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { changeAssignment, assignBulk } from '../../modules/linux/lib/assignment.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const NIL = '00000000-0000-4000-8000-000000000000'
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

const audits = async target => (await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'linux_assignment_changed' AND target = $1 ORDER BY created_at, id", [target])).rows

test('changeAssignment : champ absent conservé, audit avant/après seulement si changement, poste non pull → null', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-assign', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  assert.deepEqual(await changeAssignment(db, null, 'Admin', pull.id, { ring: 'stable' }), { before: { profile: 'field', ring: 'pilot' }, after: { profile: 'field', ring: 'stable' } })
  assert.deepEqual(await changeAssignment(db, null, 'Admin', pull.id, { ring: 'stable' }), { before: { profile: 'field', ring: 'stable' }, after: { profile: 'field', ring: 'stable' } })
  const rows = await audits(pull.id)
  assert.equal(rows.length, 1, 'pas d’audit sans changement')
  assert.equal(rows[0].by_user, 'Admin')
  assert.deepEqual(rows[0].details, { hostname: 'lx-assign', before: { profile: 'field', ring: 'pilot' }, after: { profile: 'field', ring: 'stable' } })
  const win = await seedDevice(db, { hostname: 'PC-ASSIGN' })
  assert.equal(await changeAssignment(db, null, 'Admin', win.id, { profile: 'x' }), null)
  assert.equal(await changeAssignment(db, null, 'Admin', NIL, { profile: 'x' }), null)
})

test('assignBulk : groupe natif récursif, lignes non pull et inconnues comptées (BulkResult)', { skip: SKIP }, async () => {
  const a = await seedDevice(db, { hostname: 'lx-bulk-a', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const b = await seedDevice(db, { hostname: 'lx-bulk-b', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const win = await seedDevice(db, { hostname: 'PC-BULK' })
  const { rows: [parent] } = await db.query("INSERT INTO groups (name) VALUES ('Parent') RETURNING id")
  const { rows: [child] } = await db.query("INSERT INTO groups (name) VALUES ('Enfant') RETURNING id")
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2), ($1, $3)', [parent.id, a.id, win.id])
  await db.query('INSERT INTO group_members (group_id, member_group_id) VALUES ($1, $2)', [parent.id, child.id])
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2)', [child.id, b.id])
  const byGroup = await assignBulk(db, null, 'Admin', { groupId: parent.id, profile: 'admin' })
  assert.deepEqual(byGroup, { ok: 2, skipped: 1, errors: [{ id: win.id, code: 'NOT_PULL_MANAGED' }] })
  const { rows } = await db.query('SELECT hostname, profile, ring FROM devices WHERE id = ANY($1::uuid[]) ORDER BY hostname COLLATE "C"', [[a.id, b.id, win.id]])
  assert.deepEqual(rows, [{ hostname: 'PC-BULK', profile: null, ring: null }, { hostname: 'lx-bulk-a', profile: 'admin', ring: 'pilot' }, { hostname: 'lx-bulk-b', profile: 'admin', ring: 'pilot' }])
  const byIds = await assignBulk(db, null, 'Admin', { ids: [a.id, a.id, NIL], ring: 'stable' })
  assert.deepEqual(byIds, { ok: 1, skipped: 1, errors: [{ id: NIL, code: 'NOT_FOUND' }] })
  assert.equal((await audits(a.id)).length, 2)
})
