// Escrow d'un secret chiffré par l'agent Linux (docs/linux-fleet-design.md
// §4, décision §9.3) : mot de passe du compte admin local (même table et
// même route de révélation que le LAPS Windows) ou clé de récupération LUKS
// (historique conservé, ligne précédente de même label supersédée). Reçoit
// `db` et l'état de la clé d'escrow : aucune référence à Fastify.

import { logAudit } from '../../core/lib/audit.js'
import { parseBackupConfirmation } from './checkin.js'

// Mêmes bornes que la route legacy /api/agent/admin-credential :
// RSA-2048 OAEP = 256 octets, large pour 3072/4096.
export const CIPHERTEXT_MIN = 200
export const CIPHERTEXT_MAX = 1024

const refusal = (status, code) => ({ ok: false, status, code })

// Tolérance d'horloge pour `rotated_at` : au-delà, la ligne stockée aurait
// une date future et toute rotation sincère ultérieure serait ESCROW_STALE.
export const ROTATED_AT_MAX_SKEW_MS = 5 * 60_000

// Base64 → Buffer, ou null hors bornes (le schéma a déjà validé l'alphabet).
export function decodeCiphertext(base64) {
  const buffer = Buffer.from(base64, 'base64')
  return buffer.length >= CIPHERTEXT_MIN && buffer.length <= CIPHERTEXT_MAX ? buffer : null
}

// Contrôles communs aux deux genres, dans l'ordre : clé lisible, même clé que
// celle servie au check-in, taille du chiffré. Retourne { ok: true, ciphertext }.
export function checkEscrowRequest(body, escrowInfo) {
  if (escrowInfo.status !== 'ok') return refusal(503, 'ESCROW_UNAVAILABLE')
  if (body.escrow_key_id !== escrowInfo.key_id) return refusal(409, 'ESCROW_KEY_MISMATCH')
  const ciphertext = decodeCiphertext(body.ciphertext)
  if (!ciphertext) return refusal(400, 'CIPHERTEXT_SIZE')
  return { ok: true, ciphertext }
}

// `key` = ligne linux_device_keys approuvée (req.deviceKey), `body` = EscrowRequest.
// Retourne { ok: false, status, code } ou { ok: true, ack } (EscrowAck).
export async function escrowSecret(db, log, { key, body }, { escrowInfo }) {
  const checked = checkEscrowRequest(body, escrowInfo)
  if (!checked.ok) return checked
  if (body.kind === 'local_admin' && Date.parse(body.rotated_at) > Date.now() + ROTATED_AT_MAX_SKEW_MS) {
    return refusal(400, 'ROTATED_AT_IN_FUTURE')
  }
  const byUser = 'device:' + key.key_fingerprint.slice(0, 12)
  const deviceId = key.device_id
  const { rows: settings } = await db.query("SELECT key, value FROM settings WHERE key IN ('agent.laps_recovery_username', 'linux.escrow_backup_confirmed')")
  const values = Object.fromEntries(settings.map(row => [row.key, row.value]))

  if (body.kind === 'local_admin') {
    // Même défaut que l'affectation (local_admin_username) et que l'agent Windows.
    if (body.username !== (values['agent.laps_recovery_username'] || 'opale-recovery')) return refusal(400, 'USERNAME_MISMATCH')
    // Garde anti-rejeu dans l'upsert lui-même : une rotation plus ancienne que
    // la ligne stockée ne touche rien (0 ligne → ESCROW_STALE).
    const { rows: [row] } = await db.query(`
      INSERT INTO device_admin_credentials
        (device_id, username, encrypted_password, password_changed_at, rotation_requested_at)
      VALUES ($1, $2, $3, $4, NULL)
      ON CONFLICT (device_id) DO UPDATE SET
        username              = EXCLUDED.username,
        encrypted_password    = EXCLUDED.encrypted_password,
        password_changed_at   = EXCLUDED.password_changed_at,
        rotation_requested_at = NULL
      WHERE EXCLUDED.password_changed_at > device_admin_credentials.password_changed_at
      RETURNING password_changed_at
    `, [deviceId, body.username, checked.ciphertext, body.rotated_at])
    if (!row) return refusal(409, 'ESCROW_STALE')
    await logAudit(db, log, { action: 'laps_rotated', byUser, target: deviceId, details: { username: body.username } })
    return { ok: true, ack: { kind: 'local_admin', key_id: escrowInfo.key_id, stored_at: row.password_changed_at } }
  }

  // luks_recovery : refusé tant que la sauvegarde hors site de la clé courante n'est pas confirmée.
  if (parseBackupConfirmation(values['linux.escrow_backup_confirmed'])?.key_id !== escrowInfo.key_id) {
    return refusal(409, 'ESCROW_BACKUP_UNCONFIRMED')
  }
  const client = await db.connect()
  let row
  try {
    await client.query('BEGIN')
    const inserted = await client.query(`
      INSERT INTO device_recovery_keys (device_id, kind, label, ciphertext, key_id)
      VALUES ($1, 'luks_recovery', $2, $3, $4) RETURNING id, created_at
    `, [deviceId, body.label, checked.ciphertext, escrowInfo.key_id])
    row = inserted.rows[0]
    await client.query(`
      UPDATE device_recovery_keys SET superseded_at = now()
      WHERE device_id = $1 AND kind = 'luks_recovery' AND label = $2 AND superseded_at IS NULL AND id <> $3
    `, [deviceId, body.label, row.id])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  // Jamais le chiffré dans l'audit.
  await logAudit(db, log, { action: 'linux_recovery_key_escrowed', byUser, target: deviceId, details: { label: body.label, key_id: escrowInfo.key_id } })
  return { ok: true, ack: { kind: 'luks_recovery', id: row.id, key_id: escrowInfo.key_id, stored_at: row.created_at } }
}
