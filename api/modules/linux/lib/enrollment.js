// Machine à états de l'enrôlement Linux (docs/linux-fleet-design.md §3).
// Partagée par la route agent (/enroll) et les routes admin (file d'attente).
// Toutes les fonctions reçoivent `db` (pool ou client pg) : aucune dépendance
// à Fastify, testables unitairement sur un schéma réel.

import { normalizeSerial, checkDeviceClaim } from '../../inventory/lib/device-claim.js'
import { logAudit } from '../../core/lib/audit.js'
import { createPullDevice, clearWindowsFacts } from './convert.js'
import { resolveHostnamesForBatch } from './hostname.js'

export { normalizeSerial }

// Plafond de demandes en attente : au-delà, un enrôlement inconnu est refusé
// (429) et audité. Les re-contacts de clés connues ne sont jamais bloqués.
export const PENDING_CAP = 500

// Situe une série normalisée par rapport à l'existant :
//   existing_device  : un poste (Windows/legacy) porte cette série ;
//   reimage          : un poste géré par état désiré porte cette série ;
//   clone            : une clé approuvée porte cette série sans poste, ou
//                      liée à un poste dont la série diffère ;
//   preregistered    : une pré-inscription ouverte, et rien d'autre ;
//   new              : matériel inconnu.
export async function classifyEnrollment(db, { fingerprint, serialNormalized }) {
  if (!serialNormalized) return { kind: 'new' }
  const { rows: [device] } = await db.query(
    'SELECT * FROM devices WHERE UPPER(BTRIM(serial)) = $1 ORDER BY id LIMIT 1', [serialNormalized]
  )
  const { rows: [approvedKey] } = await db.query(`
    SELECT k.*, d.serial AS device_serial FROM linux_device_keys k
    LEFT JOIN devices d ON d.id = k.device_id
    WHERE k.status = 'approved' AND k.serial_claimed = $1 AND k.key_fingerprint <> $2
    ORDER BY k.id LIMIT 1
  `, [serialNormalized, fingerprint])
  const { rows: [preregistration] } = await db.query(
    'SELECT * FROM linux_preregistrations WHERE serial = $1 AND consumed_at IS NULL', [serialNormalized]
  )
  const clone = approvedKey && (!approvedKey.device_id || normalizeSerial(approvedKey.device_serial) !== serialNormalized)
  const kind = clone ? 'clone'
    : device ? (device.managed_by === 'pull' ? 'reimage' : 'existing_device')
      : approvedKey ? 'clone' : preregistration ? 'preregistered' : 'new'
  return { kind, device, approvedKey, preregistration }
}

// Sérialise aussi les créations (aucune ligne à verrouiller pour une clé
// inconnue) : le même verrou couvre le plafond global et les collisions de
// série entre clés. Un résultat `{ ok: false }` annule la transaction.
async function transaction(db, callback) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('linux-enrollment'))")
    const result = await callback(client)
    await client.query(result.ok === false ? 'ROLLBACK' : 'COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const refusal = (code, details = {}, status = 409) => ({ ok: false, status, code, details })

// Situations approuvables sans cible ni conflit (cf. classifyEnrollment).
const NO_CONFLICT = ['new', 'preregistered']

async function bindKey(client, key, device, actor, preregistration) {
  const { rows: [updated] } = await client.query(`
    UPDATE linux_device_keys SET status = 'approved', device_id = $2,
      approved_at = now(), approved_by = $3, conflict = NULL,
      source = CASE WHEN $4::uuid IS NULL THEN 'manual' ELSE 'preregistration' END
    WHERE id = $1 RETURNING *
  `, [key.id, device.id, actor, preregistration?.id ?? null])
  if (preregistration) {
    await client.query(`
      UPDATE linux_preregistrations SET consumed_at = now(), consumed_by_key_id = $2
      WHERE id = $1 AND consumed_at IS NULL
    `, [preregistration.id, key.id])
  }
  return updated
}

// Contact d'un agent (première fois ou relance). Retourne
// { status: 'pending'|'approved'|'rejected'|'revoked'|'serial_mismatch'|'flood', key?, device?, retryAfterS }.
export async function enrollDevice(db, log, input) {
  const { fingerprint, publicKeyRaw, keyBacking, serialClaimed, hostnameClaimed, osVersion, agentVersion, ip } = input
  const serial = normalizeSerial(serialClaimed)
  const byUser = 'device:' + fingerprint.slice(0, 12)
  return transaction(db, async client => {
    const { rows: [known] } = await client.query(
      'SELECT * FROM linux_device_keys WHERE key_fingerprint = $1 FOR UPDATE', [fingerprint]
    )
    if (!known) {
      const { rows: [count] } = await client.query(
        "SELECT count(*)::int AS pending FROM linux_device_keys WHERE status = 'pending'"
      )
      if (count.pending >= PENDING_CAP) {
        await logAudit(client, log, {
          action: 'linux_enroll_flood', byUser,
          details: { level: 'error', serial, hostname: hostnameClaimed, ip, pending: count.pending },
        })
        return { status: 'flood', retryAfterS: 300 }
      }
    }
    // Une clé approuvée garde sa série ; une série encore inconnue (NULL ou
    // bidon à l'enrôlement) adopte la première série réelle présentée.
    const mismatch = known?.status === 'approved' && known.serial_claimed != null && known.serial_claimed !== serial
    const { rows: [key] } = await client.query(`
      INSERT INTO linux_device_keys (key_fingerprint, public_key, key_backing, serial_claimed, hostname_claimed, os_version, agent_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (key_fingerprint) DO UPDATE SET
        enroll_attempts  = linux_device_keys.enroll_attempts + 1,
        last_seen_at     = now(),
        key_backing      = EXCLUDED.key_backing,
        serial_claimed   = CASE WHEN linux_device_keys.status = 'approved' AND linux_device_keys.serial_claimed IS NOT NULL
                             THEN linux_device_keys.serial_claimed ELSE EXCLUDED.serial_claimed END,
        hostname_claimed = EXCLUDED.hostname_claimed,
        os_version       = EXCLUDED.os_version,
        agent_version    = EXCLUDED.agent_version
      RETURNING *
    `, [fingerprint, publicKeyRaw, keyBacking, serial, hostnameClaimed, osVersion, agentVersion])
    const retryAfterS = Date.now() - new Date(key.first_seen_at).getTime() < 3600_000 ? 30 : 300

    if (mismatch) {
      // Un poste mal configuré relance toutes les 30 s / 300 s : l'audit est
      // limité à un par clé et par heure (la tentative reste comptée).
      const { rowCount: recent } = await client.query(`
        SELECT 1 FROM audit_logs WHERE action = 'linux_key_serial_mismatch'
          AND details->>'key_id' = $1 AND created_at > now() - interval '1 hour'
      `, [key.id])
      if (!recent) {
        await logAudit(client, log, {
          action: 'linux_key_serial_mismatch', byUser, target: key.device_id,
          details: { level: 'warn', key_id: key.id, serial, expected: key.serial_claimed, hostname: hostnameClaimed },
        })
      }
      return { status: 'serial_mismatch', key, retryAfterS }
    }
    if (key.status !== 'pending') {
      const { rows: [device] } = await client.query('SELECT * FROM devices WHERE id = $1', [key.device_id])
      return { status: key.status, key, device, retryAfterS }
    }

    const match = await classifyEnrollment(client, { fingerprint, serialNormalized: serial })
    let conflict = null
    if (['existing_device', 'reimage', 'clone'].includes(match.kind)) {
      const { device, approvedKey } = match
      const claim = device && device.managed_by !== 'pull' ? await checkDeviceClaim(client, { device, serial }) : null
      conflict = {
        kind: match.kind, device_id: device?.id ?? null, hostname: device?.hostname ?? null,
        managed_by: device?.managed_by ?? null, platform: device?.platform ?? null,
        last_seen: device?.last_seen ?? null, key_id: approvedKey?.id ?? null,
        has_active_token: claim?.reason === 'active_token',
      }
      // Audité à l'apparition (ou au changement) du conflit, pas à chaque relance.
      if (key.conflict?.kind !== conflict.kind || key.conflict?.device_id !== conflict.device_id) {
        await logAudit(client, log, {
          action: 'linux_enroll_serial_conflict', byUser, target: device?.id,
          details: { level: 'warn', serial, hostname: hostnameClaimed, conflict },
        })
      }
    }
    const { rows: [pending] } = await client.query(
      'UPDATE linux_device_keys SET conflict = $2 WHERE id = $1 RETURNING *', [key.id, conflict]
    )
    if (match.kind === 'preregistered') {
      const prereg = match.preregistration
      const [resolved] = await resolveHostnamesForBatch(client, [{ preregistration: prereg, serialNormalized: serial, fingerprint }])
      // Une réservation dont le nom a été pris entre-temps reste dans la file.
      if (!resolved.error) {
        const device = await createPullDevice(client, {
          hostname: resolved.hostname, serial, profile: prereg.profile, ring: prereg.ring, assignedUserId: prereg.assigned_user_id,
        })
        const bound = await bindKey(client, pending, device, byUser, prereg)
        await logAudit(client, log, {
          action: 'linux_device_enrolled', byUser, target: device.id,
          details: { source: 'preregistration', serial, hostname: device.hostname, preregistration_id: prereg.id },
        })
        return { status: 'approved', key: bound, device, retryAfterS }
      }
    }
    return { status: 'pending', key: pending, retryAfterS }
  })
}

// Approbation d'une demande (§3 « Approval ») : nouveau poste, conversion
// d'un poste Windows (`convert_device_id`) ou ré-enrôlement d'un poste pull
// (`supersede`). `body.onlyNew` (interne, approve-bulk) refuse tout conflit
// (une pré-inscription ouverte n'en est pas un).
// Retourne { ok: true, device, key, converted } ou
// { ok: false, status, code, details } avec les codes 409 de la spec.
export async function approveEnrollment(db, log, actor, keyId, body) {
  try {
    return await transaction(db, async client => {
      const { rows: [key] } = await client.query('SELECT * FROM linux_device_keys WHERE id = $1 FOR UPDATE', [keyId])
      if (!key) return refusal('NOT_FOUND', {}, 404)
      if (key.status !== 'pending') return refusal('NOT_PENDING', { status: key.status })
      const match = await classifyEnrollment(client, { fingerprint: key.key_fingerprint, serialNormalized: key.serial_claimed })
      if (body.onlyNew && !NO_CONFLICT.includes(match.kind)) return refusal('CONFLICT', key.conflict ?? { kind: match.kind })
      const targetId = body.convert_device_id ?? (match.kind === 'reimage' ? match.device.id : null)
      if (match.kind === 'clone' || (!targetId && match.kind === 'existing_device')) {
        return refusal('CONFLICT', key.conflict ?? { kind: match.kind })
      }

      let device
      let cleared
      if (targetId) {
        const { rows: [target] } = await client.query('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [targetId])
        if (!target) return refusal('NOT_FOUND', { device_id: targetId }, 404)
        if (!key.serial_claimed || normalizeSerial(target.serial) !== key.serial_claimed) {
          return refusal('SERIAL_MISMATCH', { device_serial: target.serial, serial_claimed: key.serial_claimed })
        }
        if (match.device && match.device.id !== target.id) return refusal('CONFLICT', key.conflict ?? {})
        device = target
        if (device.managed_by === 'pull') {
          const { rows: [old] } = await client.query(
            "SELECT * FROM linux_device_keys WHERE device_id = $1 AND status = 'approved' FOR UPDATE", [device.id]
          )
          if (old && !body.supersede) {
            return refusal('ACTIVE_KEY', { old_key: old.id, hostname: device.hostname, last_seen_at: old.last_seen_at })
          }
          if (old) {
            await client.query(`
              UPDATE linux_device_keys SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded'
              WHERE id = $1
            `, [old.id, actor])
          }
        } else {
          const claim = await checkDeviceClaim(client, { device, serial: key.serial_claimed })
          if (claim?.reason === 'active_token' && !body.revoke_active_token) {
            return refusal('ACTIVE_TOKEN', { token_id: claim.token_id, hostname: device.hostname })
          }
          cleared = await clearWindowsFacts(client, device.id)
        }
      }

      const prereg = match.preregistration
      const [resolved] = await resolveHostnamesForBatch(client, [{
        explicit: body.hostname, preregistration: prereg, existing: device,
        serialNormalized: key.serial_claimed, fingerprint: key.key_fingerprint,
      }])
      if (resolved.error) return refusal(resolved.error, { hostname: resolved.hostname })
      const assignedUserId = body.assigned_user_id ?? prereg?.assigned_user_id ?? device?.assigned_user_id ?? null
      if (assignedUserId) {
        const { rowCount } = await client.query('SELECT 1 FROM users_cache WHERE entra_id = $1', [assignedUserId])
        if (!rowCount) return refusal('UNKNOWN_USER', { assigned_user_id: assignedUserId }, 400)
      }
      if (device) {
        const { rows: [updated] } = await client.query(`
          UPDATE devices SET platform = 'linux', managed_by = 'pull', hostname = $2,
            profile = $3, ring = $4, assigned_user_id = $5
          WHERE id = $1 RETURNING *
        `, [device.id, resolved.hostname, body.profile, body.ring, assignedUserId])
        device = updated
      } else {
        device = await createPullDevice(client, {
          hostname: resolved.hostname, serial: key.serial_claimed, profile: body.profile, ring: body.ring, assignedUserId,
        })
      }
      const approved = await bindKey(client, key, device, actor, prereg)
      const details = { hostname: device.hostname, serial: key.serial_claimed, key_id: key.id, profile: body.profile, ring: body.ring }
      const action = cleared ? 'linux_device_converted' : targetId ? 'linux_device_reenrolled' : 'linux_device_approved'
      await logAudit(client, log, {
        action, byUser: actor, target: device.id,
        details: cleared ? { ...details, cleared, revoke_active_token: !!body.revoke_active_token } : details,
      })
      return { ok: true, device, key: approved, converted: !!cleared }
    })
  } catch (err) {
    // Collision malgré la vérification hors transaction : même contrat 409.
    if (err.code === '23505') {
      return refusal(err.constraint === 'ux_linux_device_keys_approved' ? 'ACTIVE_KEY' : 'HOSTNAME_TAKEN', { constraint: err.constraint })
    }
    throw err
  }
}

// approve-bulk : seules les lignes sans conflit sont approuvées (matériel
// inconnu, ou pré-inscrite mais restée en file — nom réservé pris, import
// postérieur au premier contact) ; les noms de tout le lot sont résolus et
// vérifiés (base + doublons internes) avant la première transaction, puis
// chaque ligne est approuvée seule.
export async function approveEnrollments(db, log, actor, { ids, profile, ring }) {
  const unique = [...new Set(ids)]
  const { rows: keys } = await db.query('SELECT * FROM linux_device_keys WHERE id = ANY($1::uuid[])', [unique])
  const result = { ok: 0, skipped: 0, errors: [] }
  const candidates = []
  for (const id of unique) {
    const key = keys.find(k => k.id === id)
    if (!key) { result.errors.push({ id, code: 'NOT_FOUND' }); continue }
    if (key.status !== 'pending') { result.errors.push({ id, code: 'NOT_PENDING' }); continue }
    const match = await classifyEnrollment(db, { fingerprint: key.key_fingerprint, serialNormalized: key.serial_claimed })
    if (!NO_CONFLICT.includes(match.kind)) { result.errors.push({ id, code: 'CONFLICT' }); continue }
    candidates.push({ key, item: { preregistration: match.preregistration, serialNormalized: key.serial_claimed, fingerprint: key.key_fingerprint } })
  }
  const hostnames = await resolveHostnamesForBatch(db, candidates.map(c => c.item))
  for (const [i, { key }] of candidates.entries()) {
    if (hostnames[i].error) { result.errors.push({ id: key.id, code: hostnames[i].error }); continue }
    const outcome = await approveEnrollment(db, log, actor, key.id, { profile, ring, hostname: hostnames[i].hostname, onlyNew: true })
    if (outcome.ok) result.ok++
    else result.errors.push({ id: key.id, code: outcome.code })
  }
  result.skipped = result.errors.length
  return result
}

export async function rejectEnrollment(db, log, actor, keyId, reason = null) {
  return transaction(db, async client => {
    const { rows: [key] } = await client.query('SELECT * FROM linux_device_keys WHERE id = $1 FOR UPDATE', [keyId])
    if (!key) return refusal('NOT_FOUND', {}, 404)
    if (key.status !== 'pending') return refusal('NOT_PENDING', { status: key.status })
    const { rows: [rejected] } = await client.query(`
      UPDATE linux_device_keys SET status = 'rejected', rejected_at = now(), rejected_by = $2, conflict = NULL
      WHERE id = $1 RETURNING *
    `, [keyId, actor])
    await logAudit(client, log, {
      action: 'linux_device_rejected', byUser: actor, target: key.device_id,
      details: { key_id: keyId, serial: key.serial_claimed, hostname: key.hostname_claimed, reason },
    })
    return { ok: true, key: rejected }
  })
}

export async function rejectEnrollments(db, log, actor, { ids, reason = null }) {
  const result = { ok: 0, skipped: 0, errors: [] }
  for (const id of new Set(ids)) {
    const outcome = await rejectEnrollment(db, log, actor, id, reason)
    if (outcome.ok) result.ok++
    else result.errors.push({ id, code: outcome.code })
  }
  result.skipped = result.errors.length
  return result
}

// Révoque la clé approuvée d'un poste pull ; la ligne devices est conservée
// (la suppression est une autre action, cf. DELETE /api/devices/:id).
export async function revokeDeviceKey(db, log, actor, deviceId, reason) {
  return transaction(db, async client => {
    const { rows: [device] } = await client.query(
      "SELECT * FROM devices WHERE id = $1 AND managed_by = 'pull' FOR UPDATE", [deviceId]
    )
    if (!device) return refusal('NOT_FOUND', {}, 404)
    const { rows: [key] } = await client.query(`
      UPDATE linux_device_keys SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
      WHERE device_id = $1 AND status = 'approved' RETURNING *
    `, [deviceId, actor, reason])
    if (!key) return refusal('NO_ACTIVE_KEY', { hostname: device.hostname })
    await logAudit(client, log, {
      action: 'linux_device_revoked', byUser: actor, target: deviceId,
      details: { key_id: key.id, hostname: device.hostname, serial: device.serial, reason },
    })
    return { ok: true, device, key }
  })
}
