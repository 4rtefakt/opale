// Vues admin conformes aux schémas de la spec (LinuxDevice, LinuxDeviceDetail,
// Enrollment). Fastify sérialise avec ces schémas : les colonnes non déclarées
// sont ignorées, mais chaque champ requis doit être présent (null compris).

import { CHECKIN_INTERVAL_S } from './checkin.js'
import { recoveryKeyRows } from './recovery-keys.js'

const USER_REF = alias => `CASE WHEN ${alias}.entra_id IS NULL THEN NULL ELSE
  jsonb_build_object('entra_id', ${alias}.entra_id, 'display_name', ${alias}.display_name, 'email', ${alias}.email) END`

// Retard mesurable (design §5) : la tête du ring est installée depuis plus de
// deux fenêtres de check-in. Seule définition, partagée par la liste des postes
// et /rings : un poste est « en retard » quand, la tête étant installée, sa
// dernière révision appliquée avec succès en diffère.
export function ringSettled(gitMirror, ring, now = Date.now) {
  const since = gitMirror.tipSince(ring)
  return !!(since && now() - Date.parse(since) > 2 * CHECKIN_INTERVAL_S * 1000)
}

// État du miroir et de la clé d'escrow lu une fois par requête, partagé par
// toutes les lignes : têtes de ring, retard mesurable, profils présents dans
// le dépôt, key_id courant. Sans miroir servi : ring_tip, lagging et
// profile_in_repo valent null.
const IDLE_CONTEXT = { serving: false, heads: { pilot: null, stable: null }, settled: { pilot: false, stable: false }, profiles: null, keyId: null }

export async function linuxViewContext({ gitMirror, lapsKey, log, now = Date.now } = {}) {
  const serving = !!gitMirror?.serving()
  return {
    serving,
    heads:    serving ? gitMirror.heads() : IDLE_CONTEXT.heads,
    settled:  serving ? { pilot: ringSettled(gitMirror, 'pilot', now), stable: ringSettled(gitMirror, 'stable', now) } : IDLE_CONTEXT.settled,
    profiles: serving ? { pilot: await gitMirror.listProfiles('refs/heads/pilot'), stable: await gitMirror.listProfiles('refs/heads/stable') } : null,
    keyId:    lapsKey?.info(log).key_id ?? null,
  }
}

// Clé affichée : l'approuvée, sinon la dernière traitée (KeyInfo de la spec, + luks_root).
const KEY_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT k.id, k.key_fingerprint AS fingerprint, k.key_backing, k.status, k.agent_version, k.os_version,
      k.last_seen_at, k.approved_at, k.approved_by, k.revoked_at, k.revoked_by, k.revoke_reason, k.luks_root
    FROM linux_device_keys k WHERE k.device_id = d.id
    ORDER BY (k.status = 'approved') DESC, k.approved_at DESC NULLS LAST, k.id LIMIT 1
  ) k ON true`

// $1..$6 : tête pilot, tête stable, miroir servi, pilot installé, stable installé, key_id d'escrow.
// `converted_from_windows` : un poste converti existait avant sa première
// clé Linux ; un poste pull natif est créé dans la transaction qui approuve
// sa clé (même horodatage). Dérivé de l'état durable, pas d'audit_logs
// (best-effort, purgé après 365 jours).
const VIEW = `
  SELECT d.id, d.hostname, d.serial, d.platform, d.managed_by, d.profile, d.ring, d.os, d.last_seen, d.disk_used_pct,
    d.last_revision_applied, d.last_successful_revision, d.last_apply_status, d.last_apply_at,
    ${USER_REF('u')} AS assigned_user, u.display_name AS user_display_name,
    (to_jsonb(k) - 'luks_root') AS key, k.luks_root,
    COALESCE(d.last_seen > now() - interval '1 hour', false) AS online,
    CASE d.ring WHEN 'pilot' THEN $1::text WHEN 'stable' THEN $2::text END AS ring_tip,
    CASE WHEN NOT $3::boolean THEN NULL
         WHEN d.ring = 'pilot'  THEN d.last_successful_revision IS DISTINCT FROM $1::text AND $4::boolean
         WHEN d.ring = 'stable' THEN d.last_successful_revision IS DISTINCT FROM $2::text AND $5::boolean
    END AS lagging,
    COALESCE(k.luks_root, false) AND NOT EXISTS (
      SELECT 1 FROM device_recovery_keys r
      WHERE r.device_id = d.id AND r.kind = 'luks_recovery' AND r.superseded_at IS NULL AND r.key_id = $6::text
    ) AS needs_escrow,
    COALESCE(d.created_at < (SELECT min(k2.approved_at) FROM linux_device_keys k2 WHERE k2.device_id = d.id), false) AS converted_from_windows
  FROM devices d
  LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
  ${KEY_LATERAL}
  WHERE d.managed_by = 'pull'`

const contextParams = ctx => [ctx.heads.pilot, ctx.heads.stable, ctx.serving, ctx.settled.pilot, ctx.settled.stable, ctx.keyId]

function formatRow({ total_count, user_display_name, ...row }, ctx) {
  return {
    ...row,
    disk_used_pct:   row.disk_used_pct == null ? null : Number(row.disk_used_pct),
    profile_in_repo: ctx.profiles && row.ring ? ctx.profiles[row.ring].includes(row.profile) : null,
  }
}

// Filtres du schéma linuxListDevices ; les booléens arrivent typés (coercition Ajv).
export async function listLinuxDevices(db, filters = {}, ctx = IDLE_CONTEXT) {
  const { status, profile, ring, lagging, apply_status, escrow, online, q, limit = 100, offset = 0 } = filters
  const params = contextParams(ctx)
  const where = []
  const param = value => { params.push(value); return `$${params.length}` }
  if (status === 'approved') where.push(`(v.key->>'status') = 'approved'`)
  if (status === 'revoked')  where.push(`(v.key->>'status') = 'revoked'`)
  if (profile !== undefined) where.push(`v.profile = ${param(profile)}`)
  if (ring !== undefined) where.push(`v.ring = ${param(ring)}`)
  if (lagging !== undefined) where.push(`v.lagging IS ${lagging ? 'TRUE' : 'FALSE'}`)
  if (apply_status !== undefined) where.push(`v.last_apply_status = ${param(apply_status)}`)
  if (escrow !== undefined) where.push(`v.needs_escrow IS ${escrow === 'missing' ? 'TRUE' : 'FALSE'}`)
  if (online !== undefined) where.push(`v.online IS ${online ? 'TRUE' : 'FALSE'}`)
  if (q) {
    const like = param(`%${q}%`)
    where.push(`(v.hostname ILIKE ${like} OR v.serial ILIKE ${like} OR v.user_display_name ILIKE ${like})`)
  }
  const { rows } = await db.query(`
    SELECT v.*, count(*) OVER() AS total_count FROM (${VIEW}) v
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.hostname, v.id
    LIMIT ${param(limit)} OFFSET ${param(offset)}
  `, params)
  const total = Number(rows[0]?.total_count ?? 0)
  return { rows: rows.map(row => formatRow(row, ctx)), total }
}

export async function loadLinuxDeviceDetail(db, id, ctx = IDLE_CONTEXT) {
  const { rows: [device] } = await db.query(`SELECT v.* FROM (${VIEW}) v WHERE v.id = $7`, [...contextParams(ctx), id])
  if (!device) return null
  const [{ rows: [laps] }, { rows: [report] }, recoveryKeys] = await Promise.all([
    // Même forme que le champ `laps` de GET /api/devices/:id.
    db.query(`
      SELECT c.username, c.password_changed_at, c.rotation_requested_at,
        c.last_viewed_at, u.display_name AS last_viewed_by_name
      FROM device_admin_credentials c LEFT JOIN users_cache u ON u.entra_id = c.last_viewed_by
      WHERE c.device_id = $1
    `, [id]),
    db.query(`
      SELECT id, revision, status, started_at, finished_at, error_summary, log_tail, agent_version, received_at
      FROM linux_apply_reports WHERE device_id = $1
      ORDER BY started_at DESC NULLS LAST, received_at DESC LIMIT 1
    `, [id]),
    recoveryKeyRows(db, id, ctx.keyId),
  ])
  return {
    ...formatRow(device, ctx),
    // Le noyau n'a pas de colonne (CheckinRequest.kernel n'est pas persisté).
    kernel: null,
    laps: laps ?? null, last_report: report ?? null, recovery_keys: recoveryKeys,
  }
}

// Demande d'enrôlement + pré-inscription ouverte de la même série (pré-remplit
// la modale d'approbation), en une seule requête pour la liste.
const ENROLLMENT_COLUMNS = 'k.*, k.key_fingerprint AS fingerprint, left(k.key_fingerprint, 8) AS code, p.preregistration'
const ENROLLMENT_FROM = `
  FROM linux_device_keys k
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('id', p.id, 'profile', p.profile, 'ring', p.ring, 'hostname', p.hostname,
      'assigned_user', ${USER_REF('u')}) AS preregistration
    FROM linux_preregistrations p LEFT JOIN users_cache u ON u.entra_id = p.assigned_user_id
    WHERE p.serial = k.serial_claimed AND p.consumed_at IS NULL
    LIMIT 1
  ) p ON true
`

export async function loadEnrollment(db, id) {
  const { rows: [row] } = await db.query(`SELECT ${ENROLLMENT_COLUMNS} ${ENROLLMENT_FROM} WHERE k.id = $1`, [id])
  return row ?? null
}

export async function listEnrollments(db, { status = 'pending', limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(`
    SELECT ${ENROLLMENT_COLUMNS}, count(*) OVER() AS total_count
    ${ENROLLMENT_FROM}
    WHERE k.status = $1
    ORDER BY k.first_seen_at DESC, k.id
    LIMIT $2 OFFSET $3
  `, [status, limit, offset])
  const total = Number(rows[0]?.total_count ?? 0)
  return { rows: rows.map(({ total_count, ...row }) => row), total }
}
