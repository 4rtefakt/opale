// Helpers groupes natifs — consommés par routes/native-groups.js et,
// à partir de la PR 3, par les routes de déploiement et scripts.

export const GROUP_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet', 'pink', 'teal']

// Résout les membres d'un groupe : devices enrichis + users depuis users_cache.
// Retourne { devices: [...], users: [...] } — les deux tableaux sont toujours
// présents (vides si aucun membre de ce type).
export async function resolveGroupMembers(db, groupId) {
  const { rows } = await db.query(
    `SELECT
       gm.id       AS member_id,
       gm.device_id,
       gm.user_id,
       gm.added_at,
       gm.added_by,
       d.hostname,
       d.os,
       d.last_seen,
       uc.display_name,
       uc.email
     FROM group_members gm
     LEFT JOIN devices     d  ON d.id          = gm.device_id
     LEFT JOIN users_cache uc ON uc.entra_id   = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY gm.added_at`,
    [groupId]
  )

  const devices = []
  const users   = []

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

  return { devices, users }
}
