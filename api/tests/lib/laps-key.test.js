// inventory/lib/laps-key.js : clé publique dérivée de laps.key, identifiant
// stable, indisponibilité sans exception (un seul avertissement), chemin
// résolu à la lecture et non à l'import.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLapsKey, defaultLapsKeyPath } from '../../modules/inventory/lib/laps-key.js'

let dir, keyPath, privateKey

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laps-key-'))
  keyPath = path.join(dir, 'laps.key')
  privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

test('clé LAPS : aller-retour publicEncrypt(PEM dérivé) → privateDecrypt(laps.key), key_id = sha256 du SPKI DER, mémorisé', () => {
  const laps = createLapsKey({ keyPath: () => keyPath })
  const pem = laps.publicKeyPem()
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/)
  const secret = Buffer.from('mot de passe local')
  const ciphertext = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, secret)
  const plain = crypto.privateDecrypt({ key: laps.loadPrivateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ciphertext)
  assert.deepEqual(plain, secret)
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  assert.equal(laps.keyId(), crypto.createHash('sha256').update(der).digest('hex'))
  assert.equal(laps.keyId(), createLapsKey({ keyPath: () => keyPath }).keyId(), 'identifiant stable entre instances')
  assert.deepEqual(laps.info(), { status: 'ok', public_key_pem: pem, key_id: laps.keyId(), bits: 2048 })
  assert.equal(laps.loadPrivateKey(), laps.loadPrivateKey(), 'objet clé mémorisé')
})

test('clé LAPS : fichier illisible → info() unavailable sans exception, un seul warn, puis ok dès que la clé apparaît', () => {
  const missing = path.join(dir, 'absente.key')
  let current = missing
  const laps = createLapsKey({ keyPath: () => current })
  const warnings = []
  const log = { warn: (fields, message) => warnings.push({ fields, message }) }
  assert.deepEqual(laps.info(log), { status: 'unavailable', public_key_pem: null, key_id: null, bits: null })
  assert.deepEqual(laps.info(log).status, 'unavailable')
  assert.equal(warnings.length, 1, 'avertissement unique')
  assert.match(warnings[0].message, /escrow indisponible/)
  assert.throws(() => laps.publicKeyPem(), { code: 'ENOENT' })
  current = keyPath
  assert.equal(laps.info(log).status, 'ok', 'l’échec n’est pas mémorisé')
})

test('clé LAPS : le chemin par défaut lit LAPS_PRIVATE_KEY au moment de la lecture', () => {
  const previous = process.env.LAPS_PRIVATE_KEY
  try {
    process.env.LAPS_PRIVATE_KEY = '/tmp/après-import.key'
    assert.equal(defaultLapsKeyPath(), '/tmp/après-import.key')
    delete process.env.LAPS_PRIVATE_KEY
    assert.match(defaultLapsKeyPath(), /agent-go\/keys\/laps\.key$/)
  } finally {
    if (previous === undefined) delete process.env.LAPS_PRIVATE_KEY; else process.env.LAPS_PRIVATE_KEY = previous
  }
})
