// lib/device-claim.js : normalisation des numéros de série utilisée par les
// règles d'enrôlement (exchange-token, rattachement d'un token non lié).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSerial } from '../../modules/inventory/lib/device-claim.js'

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
