// Vues admin conformes aux schémas de la spec (LinuxDeviceDetail, Enrollment).
// Fastify sérialise avec ces schémas : les colonnes non déclarées sont
// ignorées, mais chaque champ requis doit être présent (null compris).

// Champs non encore alimentés dans cette PR (mirror git, rapports, escrow) :
// exposés à null / vide pour respecter le contrat.
const NOT_YET = { ring_tip: null, lagging: null, last_report: null, recovery_keys: [], needs_escrow: false, profile_in_repo: null, kernel: null, luks_root: null }

const USER_REF = alias => `CASE WHEN ${alias}.entra_id IS NULL THEN NULL ELSE
  jsonb_build_object('entra_id', ${alias}.entra_id, 'display_name', ${alias}.display_name, 'email', ${alias}.email) END`

// `converted_from_windows` : un poste converti existait avant sa première
// clé Linux ; un poste pull natif est créé dans la transaction qui approuve
// sa clé (même horodatage). Dérivé de l'état durable, pas d'audit_logs
// (best-effort, purgé après 365 jours).
export async function loadLinuxDeviceDetail(db, id) {
  const { rows: [device] } = await db.query(`
    SELECT d.*, ${USER_REF('u')} AS assigned_user,
      COALESCE(d.created_at < (SELECT min(k.approved_at) FROM linux_device_keys k WHERE k.device_id = d.id), false) AS converted_from_windows
    FROM devices d LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
    WHERE d.id = $1 AND d.managed_by = 'pull'
  `, [id])
  if (!device) return null
  const { rows: [key] } = await db.query(`
    SELECT id, key_fingerprint AS fingerprint, key_backing, status, agent_version, os_version,
      last_seen_at, approved_at, approved_by, revoked_at, revoked_by, revoke_reason
    FROM linux_device_keys WHERE device_id = $1
    ORDER BY (status = 'approved') DESC, approved_at DESC NULLS LAST, id LIMIT 1
  `, [id])
  // Même forme que le champ `laps` de GET /api/devices/:id.
  const { rows: [laps] } = await db.query(`
    SELECT c.username, c.password_changed_at, c.rotation_requested_at,
      c.last_viewed_at, u.display_name AS last_viewed_by_name
    FROM device_admin_credentials c LEFT JOIN users_cache u ON u.entra_id = c.last_viewed_by
    WHERE c.device_id = $1
  `, [id])
  return {
    ...device, ...NOT_YET, key: key ?? null, laps: laps ?? null,
    online: !!device.last_seen && Date.now() - new Date(device.last_seen).getTime() < 3600_000,
    disk_used_pct: device.disk_used_pct == null ? null : Number(device.disk_used_pct),
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
