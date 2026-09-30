// Check-in d'un agent Linux (docs/linux-fleet-design.md §2 et §4) : contrôle
// de série, mise à jour de vivacité, puis assemblage de l'affectation
// (schéma `Assignment` de la spec). Reçoit `db` et ses dépendances : aucune
// référence à Fastify, testable unitairement sur un schéma réel.

import { normalizeSerial } from '../../inventory/lib/device-claim.js'
import { logAudit } from '../../core/lib/audit.js'
import { createDeviceRateLimiter } from './device-rate.js'

export const CHECKIN_INTERVAL_S = 900
export const GIT_TOKEN_TTL_MS   = 600_000
export const RETRY_AFTER_S      = 60
export const GIT_PATH           = '/api/linux/agent/git/fleet.git'

// Origine publique de l'instance : FRONTEND_URL (obligatoire en production,
// c'est l'origine CORS — docs/CONFIGURATION.md). L'agent compare cette URL
// à son serveur configuré et refuse toute autre valeur ; sans FRONTEND_URL
// (dev) seul le chemin est servi.
export function fleetGitUrl(env = process.env) {
  return (env.FRONTEND_URL || '').trim().replace(/\/+$/, '') + GIT_PATH
}

// Réglage `linux.escrow_backup_confirmed` : JSON {key_id, by, at} ou vide.
export function parseBackupConfirmation(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed.key_id === 'string' ? parsed : null
  } catch {
    return null
  }
}

// Une ligne d'audit par clé et par heure pour un poste dont la série ne
// correspond plus (il relance à chaque cycle) ; la tentative reste refusée.
const mismatchThrottle = createDeviceRateLimiter({ max: 1, windowMs: 3600_000 })

// Assemblage pur de l'affectation à partir de l'état lu (unitairement testable).
export function buildAssignment({
  device, mirrorReady, heads, gitUrl, token, escrowInfo, backup, luksRoot, hasCurrentRecoveryKey,
  credential, escrowKeyId, localAdminUsername,
}) {
  let escrowStatus = escrowInfo.status
  if (escrowStatus === 'ok' && backup?.key_id !== escrowInfo.key_id) escrowStatus = 'backup_unconfirmed'
  // Ce qui manque au serveur sous la clé courante ; sans clé lisible il n'y a rien à chiffrer.
  const needed = []
  if (escrowInfo.status !== 'unavailable') {
    if (luksRoot && !hasCurrentRecoveryKey) needed.push('luks_recovery')
    if (!credential || escrowKeyId !== escrowInfo.key_id) needed.push('local_admin')
  }
  const assignment = {
    device_id: device.id, hostname: device.hostname, profile: device.profile, ring: device.ring,
    revision: (device.ring && heads[device.ring]) || null,
    git: mirrorReady ? { url: gitUrl, token: token.token, token_expires_at: new Date(token.expiresAt).toISOString() } : null,
    escrow: { status: escrowStatus, public_key_pem: escrowInfo.public_key_pem, key_id: escrowInfo.key_id },
    escrow_needed: needed,
    local_admin_username: localAdminUsername,
    rotate_local_admin: !!credential?.rotation_requested_at,
    checkin_interval_s: CHECKIN_INTERVAL_S,
    extra_vars: { opale_profile: device.profile, opale_ring: device.ring, opale_device_id: device.id, opale_hostname: device.hostname },
  }
  if (!mirrorReady) assignment.retry_after_s = RETRY_AFTER_S
  return assignment
}

// `key` = ligne linux_device_keys approuvée (req.deviceKey), `body` = CheckinRequest.
// Retourne { status: 'serial_mismatch' } ou { status: 'ok', assignment }.
export async function checkin(db, log, { key, body }, { gitMirror, gitTokenStore, lapsKey, gitUrl = fleetGitUrl() }) {
  const serial = normalizeSerial(body.serial)
  const byUser = 'device:' + key.key_fingerprint.slice(0, 12)
  if (key.serial_claimed != null && serial != null && serial !== key.serial_claimed) {
    if (mismatchThrottle.hit(key.id).ok) {
      await logAudit(db, log, {
        action: 'linux_key_serial_mismatch', byUser, target: key.device_id,
        details: { level: 'warn', key_id: key.id, serial, expected: key.serial_claimed, hostname: body.hostname },
      })
    }
    return { status: 'serial_mismatch' }
  }
  // Série encore inconnue (NULL ou bidon à l'enrôlement) : la première série réelle est adoptée.
  await db.query(`
    UPDATE linux_device_keys SET last_seen_at = now(), agent_version = $2, os_version = $3, luks_root = $4,
      serial_claimed = COALESCE(serial_claimed, $5)
    WHERE id = $1
  `, [key.id, body.agent_version, body.os_version, body.luks_root, serial])
  // Jamais hostname ni agent_version sur devices (design §2).
  const { rows: [device] } = await db.query(`
    UPDATE devices SET last_seen = now(), os = $2, disk_used_pct = $3 WHERE id = $1 AND managed_by = 'pull' RETURNING *
  `, [key.device_id, body.os_version, body.disk_root_pct ?? null])
  if (!device) throw new Error(`Check-in d’une clé sans poste pull : ${key.id}`)

  const escrowInfo = lapsKey.info(log)
  const [{ rows: settings }, { rows: [credential] }, { rowCount: recoveryKeys }] = await Promise.all([
    db.query("SELECT key, value FROM settings WHERE key IN ('agent.laps_recovery_username', 'linux.escrow_backup_confirmed')"),
    db.query('SELECT rotation_requested_at FROM device_admin_credentials WHERE device_id = $1', [device.id]),
    db.query(`
      SELECT 1 FROM device_recovery_keys
      WHERE device_id = $1 AND kind = 'luks_recovery' AND superseded_at IS NULL AND key_id = $2
    `, [device.id, escrowInfo.key_id]),
  ])
  const values = Object.fromEntries(settings.map(row => [row.key, row.value]))
  // Même règle que les routes git smart-HTTP : un token n'est remis que si le
  // miroir sert (contenu lu, même stale ou en erreur de fetch) ; sinon l'agent
  // saute le cycle (git null + retry_after_s) au lieu de recevoir un 503.
  const mirrorReady = gitMirror.serving()
  const token = mirrorReady ? gitTokenStore.create({ deviceId: device.id, fingerprint: key.key_fingerprint, ttlMs: GIT_TOKEN_TTL_MS }) : null
  const assignment = buildAssignment({
    device, mirrorReady, heads: gitMirror.heads(), gitUrl, token, escrowInfo,
    backup: parseBackupConfirmation(values['linux.escrow_backup_confirmed']),
    luksRoot: !!body.luks_root, hasCurrentRecoveryKey: recoveryKeys > 0,
    credential: credential ?? null, escrowKeyId: body.escrow_key_id ?? null,
    // Même défaut que /api/agent/runtime-config (agent Windows).
    localAdminUsername: values['agent.laps_recovery_username'] || 'opale-recovery',
  })
  return { status: 'ok', assignment }
}
