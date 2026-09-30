import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  canonicalString, fingerprintOf, publicKeyObjectFromRaw, signRequest, verifyDeviceRequest,
} from '../../modules/linux/lib/device-auth.js'
import { createNonceStore } from '../../modules/linux/lib/nonce-store.js'

const pair = generateKeyPairSync('ed25519')
const der = pair.publicKey.export({ type: 'spki', format: 'der' })
const raw = der.subarray(-32)
const fingerprint = fingerprintOf(raw)
const key = { id: 'key-1', public_key: raw, status: 'approved' }
const now = 1_800_000_000
const target = '/api/linux/agent/_probe?x=%2F&x=2'
const rawBody = Buffer.from('{ "value": "é" }\n')

function request(overrides = {}) {
  return {
    method: 'POST', target, rawBody, now,
    headers: signRequest({ privateKey: pair.privateKey, fingerprint, method: 'POST', target, body: rawBody, timestamp: now }),
    lookupKey: async fp => fp === fingerprint ? key : null,
    nonceStore: createNonceStore(),
    ...overrides,
  }
}

test('canonical — méthode en majuscules, cible intacte et aucun saut de ligne final', () => {
  assert.equal(canonicalString({
    method: 'post', target, timestamp: now, nonce: 'abc', bodySha256Hex: 'def',
  }), `opale-linux-v1\nPOST\n${target}\n1800000000\nabc\ndef`)
})

test('SPKI — préfixe Ed25519 et clé reconstruite identiques à generateKeyPairSync', () => {
  assert.equal(der.length, 44)
  assert.equal(der.subarray(0, -32).toString('hex'), '302a300506032b6570032100')
  assert.deepEqual(publicKeyObjectFromRaw(raw).export({ type: 'spki', format: 'der' }), der)
  assert.equal(fingerprint, createHash('sha256').update(raw).digest('hex'))
  for (const invalid of [Buffer.alloc(31), Buffer.alloc(33), raw.toString('hex')]) {
    assert.throws(() => publicKeyObjectFromRaw(invalid), TypeError)
  }
})

test('vérification — signature indépendante du helper, corps vide', async () => {
  const nonce = '01'.repeat(16)
  const canonical = `opale-linux-v1\nPOST\n${target}\n${now}\n${nonce}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  const headers = {
    'x-opale-key': fingerprint,
    'x-opale-timestamp': String(now),
    'x-opale-nonce': nonce,
    'x-opale-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64'),
  }
  assert.deepEqual(await verifyDeviceRequest(request({ headers, rawBody: Buffer.alloc(0) })), { ok: true, key })
})

test('headers — absents, multiples ou mal formés refusés avant le lookup', async () => {
  const valid = request().headers
  const bad = {
    'x-opale-key': ['a'.repeat(63), 'g'.repeat(64)],
    'x-opale-timestamp': ['1.5', '1e9', ' 1800000000', '9007199254740992'],
    'x-opale-nonce': ['a'.repeat(31), 'z'.repeat(32)],
    'x-opale-signature': [Buffer.alloc(63).toString('base64'), '!'.repeat(88), 'A'.repeat(85) + 'B=='],
  }
  for (const [header, values] of Object.entries(bad)) {
    for (const value of [undefined, [valid[header]], ...values]) {
      const result = await verifyDeviceRequest(request({
        headers: { ...valid, [header]: value },
        lookupKey: async () => assert.fail('lookup avant validation des headers'),
      }))
      assert.equal(result.code, 'SIGNATURE_INVALID', `${header}: ${value}`)
      assert.equal(result.status, 401)
    }
  }
})

test('ordre — clé inconnue, statut, horloge, nonce, signature', async () => {
  const req = request({ now: now + 600 })
  req.headers['x-opale-signature'] = Buffer.alloc(64).toString('base64')
  assert.equal((await verifyDeviceRequest({ ...req, lookupKey: async () => null })).code, 'UNKNOWN_KEY')
  for (const status of ['pending', 'rejected', 'revoked']) {
    const result = await verifyDeviceRequest({ ...req, lookupKey: async () => ({ ...key, status }) })
    assert.equal(result.code, status === 'revoked' ? 'REVOKED' : 'NOT_APPROVED')
  }
  const skew = await verifyDeviceRequest(req)
  assert.equal(skew.code, 'CLOCK_SKEW')
  assert.equal(skew.server_time, now + 600)
  req.now = now
  req.nonceStore.seen(`${fingerprint}:${req.headers['x-opale-nonce']}`)
  assert.equal((await verifyDeviceRequest(req)).code, 'NONCE_REPLAY')
  assert.equal((await verifyDeviceRequest({ ...req, nonceStore: createNonceStore() })).code, 'SIGNATURE_INVALID')
})

test('allowStatuses — les quatre statuts peuvent être autorisés pour enroll', async () => {
  const allowStatuses = ['approved', 'pending', 'rejected', 'revoked']
  for (const status of allowStatuses) {
    const result = await verifyDeviceRequest(request({ allowStatuses, lookupKey: async () => ({ ...key, status }) }))
    assert.equal(result.ok, true, status)
  }
})

test('horloge — ±300 secondes incluses, ±301 refusées', async () => {
  for (const offset of [-301, -300, 300, 301]) {
    const result = await verifyDeviceRequest(request({ now: now + offset }))
    assert.equal(result.ok, Math.abs(offset) <= 300)
    if (!result.ok) assert.equal(result.code, 'CLOCK_SKEW')
  }
})

test('signature — méthode, query string et octets du corps sont couverts', async () => {
  for (const changes of [{ method: 'PUT' }, { target: target + '&y=3' }, { rawBody: Buffer.from('{"value":"é"}') }]) {
    const req = request()
    assert.equal((await verifyDeviceRequest({ ...req, ...changes })).code, 'SIGNATURE_INVALID')
    assert.equal((await verifyDeviceRequest(req)).ok, true, 'la tentative forgée ne brûle pas le nonce')
  }
})

test('rejeu — une seule requête simultanée acceptée', async () => {
  const req = request()
  const results = await Promise.all([verifyDeviceRequest(req), verifyDeviceRequest(req)])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(results.find(r => !r.ok).code, 'NONCE_REPLAY')
})

test('hex — casse normalisée pour le lookup et le cache de nonces', async () => {
  const req = request()
  const nonce = 'ab'.repeat(16)
  for (const upper of [true, false]) {
    req.headers = signRequest({
      privateKey: pair.privateKey, fingerprint: upper ? fingerprint.toUpperCase() : fingerprint,
      method: req.method, target, body: rawBody, timestamp: now,
      nonce: upper ? nonce.toUpperCase() : nonce,
    })
    const result = await verifyDeviceRequest(req)
    if (upper) assert.equal(result.ok, true)
    else assert.equal(result.code, 'NONCE_REPLAY')
  }
})

test('nonces — le même nonce est indépendant entre deux clés', async () => {
  const req = request()
  assert.equal((await verifyDeviceRequest(req)).ok, true)
  const other = generateKeyPairSync('ed25519')
  const otherRaw = other.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  req.headers = signRequest({
    privateKey: other.privateKey, fingerprint: fingerprintOf(otherRaw), method: req.method,
    target, body: rawBody, timestamp: now, nonce: req.headers['x-opale-nonce'],
  })
  req.lookupKey = async () => ({ ...key, public_key: otherRaw })
  assert.equal((await verifyDeviceRequest(req)).ok, true)
})

test('signRequest — horodatage et nonce par défaut, corps vide', async () => {
  const headers = signRequest({ privateKey: pair.privateKey, fingerprint, method: 'POST', target })
  assert.match(headers['x-opale-nonce'], /^[0-9a-f]{32}$/)
  assert.equal((await verifyDeviceRequest(request({
    headers, now: Math.floor(Date.now() / 1000), rawBody: Buffer.alloc(0),
  }))).ok, true)
})
