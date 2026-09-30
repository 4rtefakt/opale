import { createHash, createPublicKey, randomBytes, sign, verify } from 'node:crypto'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const messages = {
  SIGNATURE_INVALID: 'Signature invalide',
  UNKNOWN_KEY:       'Clé inconnue',
  NOT_APPROVED:      'Clé non approuvée',
  REVOKED:           'Clé révoquée',
  CLOCK_SKEW:        'Horloge du device désynchronisée',
  NONCE_REPLAY:      'Nonce déjà utilisé',
}

export function canonicalString({ method, target, timestamp, nonce, bodySha256Hex }) {
  return `opale-linux-v1\n${method.toUpperCase()}\n${target}\n${timestamp}\n${nonce}\n${bodySha256Hex}`
}

export function fingerprintOf(publicKeyRaw) {
  return createHash('sha256').update(publicKeyRaw).digest('hex')
}

export function publicKeyObjectFromRaw(publicKeyRaw) {
  if (!Buffer.isBuffer(publicKeyRaw) || publicKeyRaw.length !== 32) {
    throw new TypeError('Clé publique Ed25519 attendue : Buffer de 32 octets')
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKeyRaw]), format: 'der', type: 'spki',
  })
}

export async function verifyDeviceRequest({
  method, target, headers, rawBody, now, allowStatuses = ['approved'], lookupKey, nonceStore,
}) {
  const fail = code => ({ ok: false, status: 401, code, message: messages[code] })
  const fingerprint = headers['x-opale-key']
  const timestamp   = headers['x-opale-timestamp']
  const nonce       = headers['x-opale-nonce']
  const signature   = headers['x-opale-signature']
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint)
    || typeof timestamp !== 'string' || !/^-?\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
    || typeof nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(nonce)
    || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    return fail('SIGNATURE_INVALID')
  }
  const signatureBytes = Buffer.from(signature, 'base64')
  if (signatureBytes.toString('base64') !== signature) return fail('SIGNATURE_INVALID')

  const key = await lookupKey(fingerprint.toLowerCase())
  if (!key) return fail('UNKNOWN_KEY')
  if (!allowStatuses.includes(key.status)) {
    return fail(key.status === 'revoked' ? 'REVOKED' : 'NOT_APPROVED')
  }
  if (Math.abs(now - Number(timestamp)) > 300) {
    return { ...fail('CLOCK_SKEW'), server_time: now }
  }
  const nonceId = `${fingerprint.toLowerCase()}:${nonce.toLowerCase()}`
  if (nonceStore.has(nonceId)) return fail('NONCE_REPLAY')

  const canonical = canonicalString({
    method, target, timestamp, nonce,
    bodySha256Hex: createHash('sha256').update(rawBody).digest('hex'),
  })
  if (!verify(null, Buffer.from(canonical), publicKeyObjectFromRaw(key.public_key), signatureBytes)) {
    return fail('SIGNATURE_INVALID')
  }
  // Aucun await entre la vérification et l'enregistrement : pas de double acceptation.
  if (nonceStore.seen(nonceId)) return fail('NONCE_REPLAY')
  return { ok: true, key }
}

// Le caller envoie body tel quel (Buffer ou chaîne), sans le resérialiser.
export function signRequest({
  privateKey, fingerprint, method, target, body = Buffer.alloc(0),
  timestamp = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex'),
}) {
  const canonical = canonicalString({
    method, target, timestamp, nonce,
    bodySha256Hex: createHash('sha256').update(body).digest('hex'),
  })
  return {
    'x-opale-key':       fingerprint,
    'x-opale-timestamp': String(timestamp),
    'x-opale-nonce':     nonce,
    'x-opale-signature': sign(null, Buffer.from(canonical), privateKey).toString('base64'),
  }
}
