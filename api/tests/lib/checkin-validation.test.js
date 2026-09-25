// lib/checkin-validation.js : validation des champs agent au checkin.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isNetbirdIp, normalizeIfaceType, clipStr } from '../../modules/inventory/lib/checkin-validation.js'

test('isNetbirdIp — accepte uniquement 100.64.0.0/10', () => {
  for (const ip of ['100.64.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255']) {
    assert.equal(isNetbirdIp(ip), true, ip)
  }
  for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', '127.0.0.1', '0.0.0.0',
    '255.255.255.255', '::1', '::ffff:100.64.0.1', '100.64.0', '100.64.0.1.2', ' 100.64.0.1',
    '100.064.0.1', '', null, undefined, 1684275201, {}]) {
    assert.equal(isNetbirdIp(ip), false, String(ip))
  }
})

test('normalizeIfaceType — liste blanche, défaut eth, inconnu → null', () => {
  assert.equal(normalizeIfaceType('eth'), 'eth')
  assert.equal(normalizeIfaceType('wifi'), 'wifi')
  assert.equal(normalizeIfaceType('netbird'), 'netbird')
  assert.equal(normalizeIfaceType(' WiFi '), 'wifi')
  assert.equal(normalizeIfaceType(undefined), 'eth')
  assert.equal(normalizeIfaceType(null), 'eth')
  assert.equal(normalizeIfaceType(''), 'eth')
  assert.equal(normalizeIfaceType('vpn'), null)
  assert.equal(normalizeIfaceType('<script>'), null)
  assert.equal(normalizeIfaceType(42), null)
  assert.equal(normalizeIfaceType({}), null)
})

test('clipStr — borne et tolère toute valeur JSON', () => {
  assert.equal(clipStr('abcdef', 3), 'abc')
  assert.equal(clipStr(null, 3), null)
  assert.equal(clipStr(undefined, 3), null)
  assert.equal(clipStr(12345, 3), '123')
  assert.equal(clipStr({ toString: 'x' }, 10), '[object]')
  assert.equal(clipStr(['a'], 10), '[array]')
})
