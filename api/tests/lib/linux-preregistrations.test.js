// lib/preregistrations.js : import de lignes (codes d'erreur par ligne,
// lot non atomique), préparation depuis des postes existants, liste.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAdmin } from '../fixtures/users.js'
import { importRows, fromDevices, listPreregistrations } from '../../modules/linux/lib/preregistrations.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  await seedAdmin(db, { entraId: 'oid-dupont', displayName: 'Jean Dupont', email: 'J.Dupont@Example.org' })
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

async function audits(action) {
  const { rows } = await db.query('SELECT by_user, details FROM audit_logs WHERE action = $1 ORDER BY created_at, id', [action])
  return rows
}

test('importRows — validation par ligne, insertion des lignes valides, audit unique avec les compteurs', { skip: SKIP }, async () => {
  await seedDevice(db, { hostname: 'lx-existing', serial: 'SN-EXIST' })
  // Nom déjà porté par le poste de MÊME série : conversion à venir, accepté.
  await seedDevice(db, { hostname: 'pc-same', serial: 'SN-SAME' })
  // Poste Windows en majuscules : le même nom en minuscules est pris.
  await seedDevice(db, { hostname: 'PC-UPPER', serial: 'SN-UPPER-DEV' })
  const rows = [
    { serial: 'pf3abc12 ', hostname: 'lx-dupont', profile: 'field', ring: 'stable', email: 'j.dupont@example.org', note: 'ok' },
    { serial: 'To be filled by O.E.M.', profile: 'field', ring: 'stable' },
    { serial: 'PF3ABC12', profile: 'field', ring: 'stable' },
    { serial: 'SN-BAD-PROFILE', profile: 'Field Ops', ring: 'stable' },
    { serial: 'SN-BAD-RING', profile: 'field', ring: 'canary' },
    { serial: 'SN-BAD-HOST', profile: 'field', ring: 'stable', hostname: 'LX-UPPER' },
    { serial: 'SN-TAKEN', profile: 'field', ring: 'stable', hostname: 'lx-existing' },
    { serial: 'SN-SAME', profile: 'field', ring: 'stable', hostname: 'pc-same' },
    { serial: 'SN-UNKNOWN-USER', profile: 'field', ring: 'stable', email: 'nobody@example.org' },
    { serial: '   ', profile: 'field', ring: 'stable' },
    { serial: 'SN-PREREG-TAKEN', profile: 'field', ring: 'stable', hostname: 'lx-dupont' },
    { serial: 'SN-CASE', profile: 'field', ring: 'stable', hostname: 'pc-upper' },
  ]
  const result = await importRows(db, null, 'Admin', rows)
  assert.equal(result.ok, 2)
  assert.equal(result.skipped, 10)
  assert.deepEqual(Object.fromEntries(result.errors.map(e => [e.id, e.code])), {
    1: 'PLACEHOLDER_SERIAL', 2: 'DUPLICATE_SERIAL', 3: 'INVALID_PROFILE', 4: 'INVALID_PROFILE', 5: 'INVALID_HOSTNAME',
    6: 'HOSTNAME_TAKEN', 8: 'UNKNOWN_USER', 9: 'INVALID_SERIAL', 10: 'HOSTNAME_TAKEN', 11: 'HOSTNAME_TAKEN',
  })
  const { rows: stored } = await db.query('SELECT serial, hostname, assigned_user_id, note, created_by FROM linux_preregistrations ORDER BY serial')
  assert.deepEqual(stored, [
    { serial: 'PF3ABC12', hostname: 'lx-dupont', assigned_user_id: 'oid-dupont', note: 'ok', created_by: 'Admin' },
    { serial: 'SN-SAME', hostname: 'pc-same', assigned_user_id: null, note: null, created_by: 'Admin' },
  ])
  const again = await importRows(db, null, 'Admin', [{ serial: 'pf3abc12', profile: 'field', ring: 'stable' }])
  assert.deepEqual(again.errors, [{ id: '0', code: 'DUPLICATE_SERIAL' }])
  const rowsAudit = await audits('linux_preregistrations_imported')
  assert.equal(rowsAudit.length, 2, 'un audit par appel')
  assert.deepEqual(rowsAudit[0].details, { ok: 2, skipped: 10 })
  assert.equal(rowsAudit[0].by_user, 'Admin')
})

test('fromDevices — série, nom et utilisateur repris ; NO_SERIAL, PULL_MANAGED, ALREADY_PREREGISTERED, NOT_FOUND', { skip: SKIP }, async () => {
  const win = await seedDevice(db, { hostname: 'PC-MIGRATE', serial: 'SN-MIGRATE' })
  await db.query("UPDATE devices SET assigned_user_id = 'oid-dupont' WHERE id = $1", [win.id])
  const noSerial = await seedDevice(db, { hostname: 'PC-NOSERIAL', serial: 'Default string' })
  const pull = await seedDevice(db, { hostname: 'lx-already', serial: 'SN-PULL', platform: 'linux', managed_by: 'pull' })
  const result = await fromDevices(db, null, 'Admin', {
    deviceIds: [win.id, noSerial.id, pull.id, win.id, '00000000-0000-4000-8000-000000000000'], profile: 'field', ring: 'pilot',
  })
  assert.equal(result.ok, 1)
  assert.equal(result.skipped, 3)
  assert.deepEqual(Object.fromEntries(result.errors.map(e => [e.id, e.code])), {
    [noSerial.id]: 'NO_SERIAL', [pull.id]: 'PULL_MANAGED', '00000000-0000-4000-8000-000000000000': 'NOT_FOUND',
  })
  const { rows: [p] } = await db.query("SELECT hostname, profile, ring, assigned_user_id FROM linux_preregistrations WHERE serial = 'SN-MIGRATE'")
  assert.deepEqual(p, { hostname: 'PC-MIGRATE', profile: 'field', ring: 'pilot', assigned_user_id: 'oid-dupont' })
  const again = await fromDevices(db, null, 'Admin', { deviceIds: [win.id], profile: 'field', ring: 'pilot' })
  assert.deepEqual(again.errors, [{ id: win.id, code: 'ALREADY_PREREGISTERED' }])

  // Par groupe natif (récursif) : mêmes règles.
  const { rows: [group] } = await db.query("INSERT INTO groups (name) VALUES ('Vague 1') RETURNING id")
  const other = await seedDevice(db, { hostname: 'PC-GROUPED', serial: 'SN-GROUPED' })
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2), ($1, $3)', [group.id, other.id, pull.id])
  const grouped = await fromDevices(db, null, 'Admin', { groupId: group.id, profile: 'field', ring: 'pilot' })
  assert.equal(grouped.ok, 1)
  assert.deepEqual(grouped.errors, [{ id: pull.id, code: 'PULL_MANAGED' }])
  assert.equal((await audits('linux_preregistrations_imported')).at(-1).details.source, 'devices')
})

test('listPreregistrations — ouvertes par défaut, consommées sur demande, utilisateur et poste de même série', { skip: SKIP }, async () => {
  const open = await listPreregistrations(db)
  assert.ok(open.total >= 3)
  const migrate = open.rows.find(r => r.serial === 'SN-MIGRATE')
  assert.deepEqual(migrate.assigned_user, { entra_id: 'oid-dupont', display_name: 'Jean Dupont', email: 'J.Dupont@Example.org' })
  assert.equal(migrate.matches_device.hostname, 'PC-MIGRATE')
  assert.equal(migrate.matches_device.managed_by, null)
  assert.equal(migrate.consumed_at, null)
  const fresh = open.rows.find(r => r.serial === 'PF3ABC12')
  assert.equal(fresh.matches_device, null)
  await db.query("UPDATE linux_preregistrations SET consumed_at = now() WHERE serial = 'PF3ABC12'")
  const consumed = await listPreregistrations(db, { consumed: true })
  assert.deepEqual(consumed.rows.map(r => r.serial), ['PF3ABC12'])
  assert.equal(consumed.total, 1)
  const page = await listPreregistrations(db, { limit: 1, offset: 1 })
  assert.equal(page.rows.length, 1)
  assert.equal(page.total, open.total - 1)
})
