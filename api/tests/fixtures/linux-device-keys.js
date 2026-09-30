import { createHash, generateKeyPairSync } from 'node:crypto'

export async function seedLinuxDeviceKey(db, {
  deviceId = null,
  status = 'pending',
  serialClaimed = null,
  hostnameClaimed = null,
  keyBacking = 'software',
  publicKey = null,
} = {}) {
  // Une clé publique brute fournie permet les cas invalides ; sa clé privée
  // n'est alors pas connue. Sinon, la paire retournée permet de signer.
  const pair = publicKey ? null : generateKeyPairSync('ed25519')
  const publicKeyRaw = publicKey ?? pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const fingerprint = createHash('sha256').update(publicKeyRaw).digest('hex')
  const { rows: [row] } = await db.query(`
    INSERT INTO linux_device_keys
      (device_id, status, serial_claimed, hostname_claimed, key_backing, key_fingerprint, public_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [deviceId, status, serialClaimed, hostnameClaimed, keyBacking, fingerprint, publicKeyRaw])
  return { id: row.id, fingerprint, privateKey: pair?.privateKey ?? null, publicKeyRaw }
}
