// Pré-inscriptions (docs/linux-fleet-design.md §3) : import de lignes
// validées une à une (lot non atomique) et préparation de la migration de
// postes Windows existants. Les séries sont normalisées comme partout
// (device-claim.js), les e-mails résolus sur users_cache sans casse.

import { normalizeSerial } from './enrollment.js'
import { isValidHostname } from './hostname.js'
import { resolveGroupDeviceIds } from '../../groups/lib/groups.js'
import { logAudit } from '../../core/lib/audit.js'

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const RINGS = ['pilot', 'stable']

export async function importRows(db, log, actor, rows) {
  const result = { ok: 0, skipped: 0, errors: [] }
  const seen = new Set()
  for (const [index, row] of rows.entries()) {
    let code
    let assignedUserId = null
    const serial = normalizeSerial(row.serial)
    if (typeof row.serial !== 'string' || !row.serial.trim() || row.serial.length > 100) code = 'INVALID_SERIAL'
    else if (!serial) code = 'PLACEHOLDER_SERIAL'
    else if (seen.has(serial)) code = 'DUPLICATE_SERIAL'
    else if (!PROFILE_RE.test(row.profile ?? '') || !RINGS.includes(row.ring)) code = 'INVALID_PROFILE'
    else if (row.hostname != null && !isValidHostname(row.hostname)) code = 'INVALID_HOSTNAME'
    if (serial) seen.add(serial)
    if (!code) {
      const { rowCount } = await db.query('SELECT 1 FROM linux_preregistrations WHERE serial = $1', [serial])
      if (rowCount) code = 'DUPLICATE_SERIAL'
    }
    if (!code && row.hostname) {
      // Un nom déjà porté par cette série prépare une conversion autorisée.
      // Comparaison sans casse (postes Windows en majuscules, cf. hostname.js).
      const { rowCount } = await db.query(`
        SELECT 1 FROM devices WHERE LOWER(hostname) = LOWER($1) AND UPPER(BTRIM(serial)) IS DISTINCT FROM $2
        UNION ALL SELECT 1 FROM linux_preregistrations WHERE LOWER(hostname) = LOWER($1)
      `, [row.hostname, serial])
      if (rowCount) code = 'HOSTNAME_TAKEN'
    }
    if (!code && row.email) {
      const { rows: [user] } = await db.query('SELECT entra_id FROM users_cache WHERE LOWER(email) = LOWER($1)', [row.email])
      if (!user) code = 'UNKNOWN_USER'
      else assignedUserId = user.entra_id
    }
    if (!code) {
      try {
        await db.query(`
          INSERT INTO linux_preregistrations (serial, hostname, profile, ring, assigned_user_id, note, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [serial, row.hostname ?? null, row.profile, row.ring, assignedUserId, row.note ?? null, actor])
        result.ok++
      } catch (err) {
        if (err.code !== '23505') throw err
        code = err.constraint.includes('serial') ? 'DUPLICATE_SERIAL' : 'HOSTNAME_TAKEN'
      }
    }
    if (code) result.errors.push({ id: String(index), code })
  }
  result.skipped = result.errors.length
  await logAudit(db, log, { action: 'linux_preregistrations_imported', byUser: actor, details: { ok: result.ok, skipped: result.skipped } })
  return result
}

// « Préparer la migration Linux » depuis Postes : une pré-inscription par
// poste avec sa série, son nom et son utilisateur. Le nom (souvent en
// majuscules) est conservé tel quel : à l'approbation, la conversion garde
// le nom du poste existant.
export async function fromDevices(db, log, actor, { deviceIds, groupId, profile, ring }) {
  const ids = [...new Set(groupId ? await resolveGroupDeviceIds(db, groupId) : deviceIds)]
  const result = { ok: 0, skipped: 0, errors: [] }
  const { rows } = await db.query('SELECT * FROM devices WHERE id = ANY($1::uuid[])', [ids])
  for (const id of ids) {
    const device = rows.find(row => row.id === id)
    const serial = normalizeSerial(device?.serial)
    let code = !device ? 'NOT_FOUND' : device.managed_by === 'pull' ? 'PULL_MANAGED' : !serial ? 'NO_SERIAL' : null
    if (!code) {
      const { rowCount } = await db.query(`
        INSERT INTO linux_preregistrations (serial, hostname, profile, ring, assigned_user_id, created_by)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
      `, [serial, device.hostname, profile, ring, device.assigned_user_id, actor])
      if (rowCount) result.ok++
      else code = 'ALREADY_PREREGISTERED'
    }
    if (code) result.errors.push({ id, code })
  }
  result.skipped = result.errors.length
  await logAudit(db, log, { action: 'linux_preregistrations_imported', byUser: actor, details: { ok: result.ok, skipped: result.skipped, source: 'devices' } })
  return result
}

// Liste conforme au schéma Preregistration : utilisateur résolu et poste
// existant de même série (« sera converti à l'approbation »).
export async function listPreregistrations(db, { consumed = false, limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(`
    SELECT p.id, p.serial, p.hostname, p.profile, p.ring, p.note, p.created_by, p.created_at,
      p.consumed_at, p.consumed_by_key_id,
      CASE WHEN u.entra_id IS NULL THEN NULL ELSE
        jsonb_build_object('entra_id', u.entra_id, 'display_name', u.display_name, 'email', u.email) END AS assigned_user,
      d.matches_device,
      count(*) OVER() AS total_count
    FROM linux_preregistrations p
    LEFT JOIN users_cache u ON u.entra_id = p.assigned_user_id
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id', d.id, 'hostname', d.hostname, 'platform', d.platform, 'managed_by', d.managed_by) AS matches_device
      FROM devices d WHERE UPPER(BTRIM(d.serial)) = p.serial ORDER BY d.id LIMIT 1
    ) d ON true
    WHERE (p.consumed_at IS NOT NULL) = $1
    ORDER BY p.created_at DESC, p.id
    LIMIT $2 OFFSET $3
  `, [consumed, limit, offset])
  const total = Number(rows[0]?.total_count ?? 0)
  return { rows: rows.map(({ total_count, ...row }) => row), total }
}
