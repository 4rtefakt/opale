// Clés de récupération escrowées d'un poste (docs/linux-fleet-design.md §5) :
// métadonnées (jamais le secret) et révélation « fail-closed » — le secret
// est déchiffré en mémoire, puis la ligne d'audit avec le motif et
// `last_viewed_*` sont validés dans UNE transaction ; il n'est renvoyé
// qu'après le COMMIT. Reçoit `db` et la clé d'escrow : aucune référence à
// Fastify.

import crypto from 'node:crypto'
import { logAudit, insertAudit } from '../../core/lib/audit.js'

const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }

// Lignes RecoveryKeyMeta d'un poste, courante(s) d'abord (`current` = non
// supersédée ET chiffrée sous la clé d'escrow servie, `keyId`).
export async function recoveryKeyRows(db, deviceId, keyId) {
  const { rows } = await db.query(`
    SELECT r.id, r.kind, r.label, r.key_id, r.created_at, r.superseded_at,
      (r.superseded_at IS NULL AND r.key_id = $2::text) AS current,
      r.last_viewed_at, u.display_name AS last_viewed_by_name
    FROM device_recovery_keys r LEFT JOIN users_cache u ON u.entra_id = r.last_viewed_by
    WHERE r.device_id = $1 ORDER BY current DESC, r.created_at DESC, r.id
  `, [deviceId, keyId])
  return rows
}

// null si le poste n'est pas géré par état désiré (404 côté route).
export async function listRecoveryKeys(db, deviceId, keyId) {
  const { rowCount } = await db.query("SELECT 1 FROM devices WHERE id = $1 AND managed_by = 'pull'", [deviceId])
  return rowCount ? recoveryKeyRows(db, deviceId, keyId) : null
}

// Déchiffrement RSA-OAEP-SHA256 avec la clé privée d'escrow ; lève si la clé
// est illisible ou si le chiffré ne lui correspond pas (autre key_id).
export function decryptSecret(privateKey, ciphertext) {
  return crypto.privateDecrypt({ key: privateKey, ...OAEP }, ciphertext).toString('utf8')
}

// Ordre imposé : charger → déchiffrer → { audit + last_viewed } validés → envoyer.
// `byUser` va dans l'audit, `viewerId` (entra_id) dans last_viewed_by.
// Retourne { ok: false, status, code } ou { ok: true, secret } (RevealedSecret).
export async function revealRecoveryKey(db, log, { deviceId, keyId, byUser, viewerId, reason }, { lapsKey }) {
  const { rows: [row] } = await db.query('SELECT * FROM device_recovery_keys WHERE id = $1 AND device_id = $2', [keyId, deviceId])
  if (!row) return { ok: false, status: 404, code: 'NOT_FOUND' }
  const details = { label: row.label, key_id: row.key_id, reason }

  let secret
  try {
    secret = decryptSecret(lapsKey.loadPrivateKey(), row.ciphertext)
  } catch (err) {
    log?.error?.({ err: err.message, key: row.id }, 'Déchiffrement d’une clé de récupération impossible')
    await logAudit(db, log, { action: 'linux_recovery_key_viewed', byUser, target: deviceId, details: { ...details, outcome: 'failed' } })
    return { ok: false, status: 500, code: 'DECRYPT_FAILED' }
  }

  // INSERT direct (insertAudit) et non logAudit : logAudit avale les erreurs
  // d'écriture, ce qui laisserait partir un secret sans trace. Ici un échec
  // annule la transaction et le secret n'est pas renvoyé.
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await insertAudit(client, { action: 'linux_recovery_key_viewed', byUser, target: deviceId, details: { ...details, outcome: 'ok' } })
    await client.query('UPDATE device_recovery_keys SET last_viewed_at = now(), last_viewed_by = $2 WHERE id = $1', [row.id, viewerId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log?.error?.({ err: err.message, key: row.id }, 'Trace d’audit impossible : clé de récupération non révélée')
    return { ok: false, status: 500, code: 'AUDIT_FAILED' }
  } finally {
    client.release()
  }
  return { ok: true, secret: { kind: row.kind, label: row.label, secret, key_id: row.key_id, created_at: row.created_at } }
}
