// Helpers groupes natifs — consommés par routes/native-groups.js et,
// à partir de la PR 3, par les routes de déploiement et scripts.

export const GROUP_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet', 'pink', 'teal']

// Résout les membres DIRECTS d'un groupe : devices + users + sous-groupes.
// Retourne { devices, users, groups } (toujours présents, vides sinon).
// Les membres EFFECTIFS (sous-groupes aplatis) → resolveGroupDeviceIds /
// resolveGroupUserIds.
export async function resolveGroupMembers(db, groupId) {
  const { rows } = await db.query(
    `SELECT
       gm.id       AS member_id,
       gm.device_id,
       gm.user_id,
       gm.member_group_id,
       gm.added_at,
       gm.added_by,
       d.hostname,
       d.os,
       d.last_seen,
       uc.display_name,
       uc.email,
       g.name   AS group_name,
       g.color  AS group_color,
       g.source AS group_source,
       (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS group_member_count
     FROM group_members gm
     LEFT JOIN devices     d  ON d.id        = gm.device_id
     LEFT JOIN users_cache uc ON uc.entra_id = gm.user_id
     LEFT JOIN groups      g  ON g.id        = gm.member_group_id
     WHERE gm.group_id = $1
     ORDER BY gm.added_at`,
    [groupId]
  )

  const devices = []
  const users   = []
  const groups  = []

  for (const r of rows) {
    if (r.device_id) {
      devices.push({
        member_id: r.member_id,
        device_id: r.device_id,
        hostname:  r.hostname,
        os:        r.os,
        last_seen: r.last_seen,
        added_at:  r.added_at,
        added_by:  r.added_by,
      })
    } else if (r.member_group_id) {
      groups.push({
        member_id:    r.member_id,
        group_id:     r.member_group_id,
        name:         r.group_name ?? null,
        color:        r.group_color ?? 'slate',
        source:       r.group_source ?? null,
        member_count: parseInt(r.group_member_count ?? 0, 10),
        added_at:     r.added_at,
        added_by:     r.added_by,
      })
    } else {
      users.push({
        member_id:    r.member_id,
        user_id:      r.user_id,
        display_name: r.display_name ?? null,
        email:        r.email ?? null,
        added_at:     r.added_at,
        added_by:     r.added_by,
      })
    }
  }

  return { devices, users, groups }
}

// Profondeur max de nesting — garde-fou en plus du set anti-cycle.
const MAX_GROUP_DEPTH = 20

// IDs de devices EFFECTIFS d'un groupe (récursif sur les sous-groupes),
// dédupliqués. Garde anti-cycle (_seen) + profondeur. Utilisé par les
// déploiements / scripts ciblant un groupe natif.
export async function resolveGroupDeviceIds(db, groupId, _seen = new Set(), _depth = 0) {
  if (_depth > MAX_GROUP_DEPTH || _seen.has(groupId)) return []
  _seen.add(groupId)
  const { rows } = await db.query(
    `SELECT device_id, member_group_id FROM group_members WHERE group_id = $1`, [groupId]
  )
  const ids = new Set()
  for (const r of rows) {
    if (r.device_id) ids.add(r.device_id)
    else if (r.member_group_id) {
      for (const id of await resolveGroupDeviceIds(db, r.member_group_id, _seen, _depth + 1)) ids.add(id)
    }
  }
  return [...ids]
}

// IDs (entra_id) d'utilisateurs EFFECTIFS d'un groupe (récursif), dédupliqués.
export async function resolveGroupUserIds(db, groupId, _seen = new Set(), _depth = 0) {
  if (_depth > MAX_GROUP_DEPTH || _seen.has(groupId)) return []
  _seen.add(groupId)
  const { rows } = await db.query(
    `SELECT user_id, member_group_id FROM group_members WHERE group_id = $1`, [groupId]
  )
  const ids = new Set()
  for (const r of rows) {
    if (r.user_id) ids.add(r.user_id)
    else if (r.member_group_id) {
      for (const id of await resolveGroupUserIds(db, r.member_group_id, _seen, _depth + 1)) ids.add(id)
    }
  }
  return [...ids]
}
