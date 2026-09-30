// lib/escrow.js, partie pure : bornes du chiffré décodé et ordre des
// contrôles communs (clé lisible, même clé que celle servie, taille).
// Les écritures (upsert du compte local, insertion/supersession LUKS,
// audits) sont couvertes par tests/routes/linux-escrow.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodeCiphertext, checkEscrowRequest, CIPHERTEXT_MIN, CIPHERTEXT_MAX } from '../../modules/linux/lib/escrow.js'

const KEY_ID = 'f'.repeat(64)
const b64 = size => Buffer.alloc(size, 7).toString('base64')
const ok = { status: 'ok', key_id: KEY_ID, public_key_pem: 'PEM', bits: 2048 }

test('decodeCiphertext — mêmes bornes que la route legacy : 200..1024 octets décodés', () => {
  assert.equal(decodeCiphertext(b64(CIPHERTEXT_MIN - 1)), null)
  assert.equal(decodeCiphertext(b64(CIPHERTEXT_MIN)).length, CIPHERTEXT_MIN)
  assert.equal(decodeCiphertext(b64(256)).length, 256, 'RSA-2048 OAEP')
  assert.equal(decodeCiphertext(b64(CIPHERTEXT_MAX)).length, CIPHERTEXT_MAX)
  assert.equal(decodeCiphertext(b64(CIPHERTEXT_MAX + 1)), null)
  assert.equal(decodeCiphertext(''), null)
})

test('checkEscrowRequest — clé illisible d’abord (503), puis clé différente (409), puis taille (400)', () => {
  const body = { escrow_key_id: 'e'.repeat(64), ciphertext: b64(10) }
  assert.deepEqual(checkEscrowRequest(body, { status: 'unavailable', key_id: null }), { ok: false, status: 503, code: 'ESCROW_UNAVAILABLE' })
  assert.deepEqual(checkEscrowRequest(body, ok), { ok: false, status: 409, code: 'ESCROW_KEY_MISMATCH' })
  assert.deepEqual(checkEscrowRequest({ ...body, escrow_key_id: KEY_ID }, ok), { ok: false, status: 400, code: 'CIPHERTEXT_SIZE' })
  const accepted = checkEscrowRequest({ escrow_key_id: KEY_ID, ciphertext: b64(256) }, ok)
  assert.equal(accepted.ok, true)
  assert.ok(Buffer.isBuffer(accepted.ciphertext))
  assert.equal(accepted.ciphertext.length, 256)
})
