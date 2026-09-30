// lib/device-claim.js : normalisation des numéros de série utilisée par les
// règles d'enrôlement (exchange-token, rattachement d'un token non lié).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSerial, checkDeviceClaim, CLAIM_REFUSAL_MESSAGES } from '../../modules/inventory/lib/device-claim.js'

// Un poste géré par état désiré (Linux) est refusé avant tout autre contrôle :
// ni la série ni les tokens ne sont consultés.
test('checkDeviceClaim — poste pull_managed refusé en premier, sans requête', async () => {
  const db = { query: async () => { throw new Error('aucune requête attendue') } }
  const device = { id: 'dev-1', serial: 'SN-1', managed_by: 'pull' }
  assert.deepEqual(await checkDeviceClaim(db, { device, serial: 'AUTRE' }), { reason: 'pull_managed' })
  assert.deepEqual(await checkDeviceClaim(db, { device, serial: 'SN-1' }), { reason: 'pull_managed' })
  assert.match(CLAIM_REFUSAL_MESSAGES.pull_managed, /état désiré/)
})

test('checkDeviceClaim — poste legacy : contrôle de série puis de token inchangés', async () => {
  const calls = []
  const db = { query: async (sql, params) => { calls.push(params); return { rows: [] } } }
  assert.equal(await checkDeviceClaim(db, { device: { id: 'dev-2', serial: 'SN-2', managed_by: null }, serial: 'sn-2' }), null)
  assert.equal(calls.length, 1)
  assert.deepEqual(await checkDeviceClaim(db, { device: { id: 'dev-2', serial: 'SN-2' }, serial: 'SN-3' }), { reason: 'serial_mismatch' })
  assert.equal(calls.length, 1, 'série discordante : aucune requête token')
})

test('normalizeSerial — trim + insensible à la casse', () => {
  assert.equal(normalizeSerial('  5cg1234xyz \t'), '5CG1234XYZ')
  assert.equal(normalizeSerial('5CG1234XYZ'), normalizeSerial('5cg1234xyz'))
})

test('normalizeSerial — absent ou bidon → null', () => {
  for (const v of [null, undefined, '', '   ', 'To be filled by O.E.M.', 'System Serial Number',
    'SystemSerialNumber', 'Default string', 'N/A', 'none', 'unknown', '0', ' TO BE FILLED ',
    42, {}, { toString: 'x' }, ['SN']]) {
    assert.equal(normalizeSerial(v), null, JSON.stringify(v))
  }
})
