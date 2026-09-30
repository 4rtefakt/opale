// lib/hostname.js : règle de résolution du nom (5 branches), validation
// RFC-1123 et vérification d'un lot contre la base et en interne.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { isValidHostname, resolveHostname, resolveHostnamesForBatch } from '../../modules/linux/lib/hostname.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const fingerprint = 'abcdef0123456789'.repeat(4)
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

test('isValidHostname — label RFC-1123 en minuscules', () => {
  for (const ok of ['a', 'lx-pf3abc12', 'pc1', 'a'.repeat(63)]) assert.equal(isValidHostname(ok), true, ok)
  for (const ko of ['', 'PC-DUPONT', '-lx', 'lx-', 'lx_1', 'lx.local', 'a'.repeat(64), null, 42]) {
    assert.equal(isValidHostname(ko), false, String(ko))
  }
})

test('resolveHostname — explicite > pré-inscription > poste existant > lx-<série> > lx-<empreinte>', () => {
  const preregistration = { hostname: 'lx-prereg' }
  const existing = { hostname: 'PC-EXISTING' }
  assert.equal(resolveHostname({ explicit: 'lx-explicit', preregistration, existing, serialNormalized: 'SN1', fingerprint }), 'lx-explicit')
  assert.equal(resolveHostname({ preregistration, existing, serialNormalized: 'SN1', fingerprint }), 'lx-prereg')
  assert.equal(resolveHostname({ preregistration: { hostname: null }, existing, serialNormalized: 'SN1', fingerprint }), 'PC-EXISTING')
  assert.equal(resolveHostname({ serialNormalized: 'PF3ABC12', fingerprint }), 'lx-pf3abc12')
  assert.equal(resolveHostname({ serialNormalized: null, fingerprint }), 'lx-' + fingerprint.slice(0, 12))
  // Série non exploitable en label (caractères hors [a-z0-9-], trop longue) : repli sur l'empreinte.
  assert.equal(resolveHostname({ serialNormalized: 'SN 1/2', fingerprint }), 'lx-' + fingerprint.slice(0, 12))
  assert.equal(resolveHostname({ serialNormalized: 'X'.repeat(62), fingerprint }), 'lx-' + fingerprint.slice(0, 12))
})

test('resolveHostnamesForBatch — collisions en base (sauf le poste cible) et à l’intérieur du lot, sans casse', { skip: SKIP }, async () => {
  const taken = await seedDevice(db, { hostname: 'lx-taken' })
  const target = await seedDevice(db, { hostname: 'PC-TARGET', serial: 'SN-T' })
  const result = await resolveHostnamesForBatch(db, [
    { explicit: 'lx-taken', fingerprint },
    { existing: target, serialNormalized: 'SN-T', fingerprint },
    { serialNormalized: 'SN-DUP', fingerprint },
    { serialNormalized: 'SN-DUP', fingerprint },
    { serialNormalized: 'SN-FREE', fingerprint },
  ])
  assert.deepEqual(result, [
    { error: 'HOSTNAME_TAKEN', hostname: 'lx-taken' },
    { hostname: 'PC-TARGET' },
    { error: 'HOSTNAME_TAKEN', hostname: 'lx-sn-dup' },
    { error: 'HOSTNAME_TAKEN', hostname: 'lx-sn-dup' },
    { hostname: 'lx-sn-free' },
  ])
  assert.ok(taken.id)
  // Le nom d'un autre poste, ou celui de la cible demandé aussi par une autre ligne : refusés.
  assert.deepEqual(await resolveHostnamesForBatch(db, [{ explicit: 'PC-TARGET', fingerprint }]), [{ error: 'HOSTNAME_TAKEN', hostname: 'PC-TARGET' }])
  assert.deepEqual(
    (await resolveHostnamesForBatch(db, [{ existing: target, fingerprint }, { explicit: 'PC-TARGET', fingerprint }])).map(r => r.error),
    ['HOSTNAME_TAKEN', 'HOSTNAME_TAKEN'],
  )
  // Même nom à la casse près : un poste Windows `PC-TARGET` bloque `pc-target`
  // pour un autre matériel, mais pas pour la cible elle-même.
  assert.deepEqual(await resolveHostnamesForBatch(db, [{ explicit: 'pc-target', fingerprint }]), [{ error: 'HOSTNAME_TAKEN', hostname: 'pc-target' }])
  assert.deepEqual(await resolveHostnamesForBatch(db, [{ existing: target, explicit: 'pc-target', fingerprint }]), [{ hostname: 'pc-target' }])
  assert.deepEqual(
    (await resolveHostnamesForBatch(db, [{ explicit: 'lx-dup-case', fingerprint }, { explicit: 'LX-DUP-CASE', fingerprint }])).map(r => r.error),
    ['HOSTNAME_TAKEN', 'HOSTNAME_TAKEN'],
  )
  assert.deepEqual(await resolveHostnamesForBatch(db, []), [])
})
