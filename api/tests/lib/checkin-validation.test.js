// lib/checkin-validation.js : validation des champs agent au checkin.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isNetbirdIp, normalizeIfaceType, clipStr, truncateMiddle, stripNul } from '../../modules/inventory/lib/checkin-validation.js'

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

test('truncateMiddle — ≤ maxBytes, début + fin conservés, jamais de caractère coupé', () => {
  assert.equal(truncateMiddle('court', 8192), 'court')
  const exact = 'x'.repeat(8192)
  assert.equal(truncateMiddle(exact, 8192), exact)

  for (const text of [
    'HEAD-' + 'é'.repeat(10000) + '-TAIL',       // coupures au milieu de caractères 2 octets
    'HEAD-' + '€'.repeat(10000) + '-TAIL',       // 3 octets
    'HEAD-' + '😀'.repeat(10000) + '-TAIL',      // 4 octets (paires de substitution)
    'HEAD-' + 'a'.repeat(100000) + '-TAIL',
  ]) {
    const out = truncateMiddle(text, 8192)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 8192, `${Buffer.byteLength(out, 'utf8')} octets`)
    assert.ok(Buffer.byteLength(out, 'utf8') > 7000, 'la place disponible est utilisée')
    assert.ok(out.startsWith('HEAD-'))
    assert.ok(out.endsWith('-TAIL'))
    assert.ok(!out.includes('�'))
    assert.match(out, new RegExp(`log tronqué : ${Buffer.byteLength(text, 'utf8')} octets`))
  }
})

test('stripNul — retire les octets NUL de toutes les chaînes (valeurs et clés), structure intacte', () => {
  const input = {
    hostname: 'PC\u0000-1', n: 3, ok: true, none: null,
    network: [{ mac: 'AA\u0000BB', ip: '10.0.0.1' }, null, 'x\u0000'],
    system_info: { 'k\u0000ey': { deep: ['\u0000v'] } },
  }
  assert.deepEqual(stripNul(input), {
    hostname: 'PC-1', n: 3, ok: true, none: null,
    network: [{ mac: 'AABB', ip: '10.0.0.1' }, null, 'x'],
    system_info: { key: { deep: ['v'] } },
  })
  assert.equal(stripNul('a\u0000b'), 'ab')
  assert.equal(stripNul(42), 42)
})

test('stripNul — une clé qui devient __proto__ / constructor / prototype après nettoyage est écartée', () => {
  // Les clés littérales __proto__ / constructor.prototype sont déjà refusées
  // par le parseur JSON de Fastify ; leurs variantes masquées par un NUL ne
  // le sont pas et, une fois nettoyées, remplaçaient le prototype de l'objet.
  const out = stripNul(JSON.parse('{"__pro\\u0000to__": {"polluted": true}, "construct\\u0000or": 1, "proto\\u0000type": 2, "ok": "x\\u0000"}'))
  assert.deepEqual(Object.keys(out), ['ok'])
  assert.equal(out.ok, 'x')
  assert.equal(Object.getPrototypeOf(out), Object.prototype)
  assert.equal(out.polluted, undefined)
})
