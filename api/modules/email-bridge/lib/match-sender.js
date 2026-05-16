// Matching expéditeur → user Opale + son device principal (Phase 2, issue #8).
//
// Le matching se fait UNIQUEMENT par email (LOWER, exact). On ne tente pas :
//   - de matcher par nom (trop fragile, faux positifs probables)
//   - de matcher par alias (pas de table d'alias en DB, kelvin@ ≠ kelvin.foo@)
//   - de matcher fuzzy (un mail externe finit dans `other`, pas dans ticket)
//
// Conséquences de ce choix strict :
//   - Un collègue qui écrit depuis son adresse perso (gmail, etc.) tombe
//     en "expéditeur inconnu" — la proposition sera créée sans suggested_user.
//     Le maintainer associe à la main à l'acceptation.
//   - Un mail depuis un domaine externe (vendeur, partenaire) tombe pareil :
//     proposition sans user, à classer "other" idéalement par le classifieur.
//
// Pour le device : on prend le premier device dont `assigned_user_id` matche
// l'utilisateur trouvé. Si plusieurs devices, on ne devine pas — on prend
// le plus récemment vu (last_seen DESC).

// Retourne { user_id, user_email, user_name, device_id, device_hostname } | {}
// Toujours un objet (jamais null) pour simplifier le caller.
export async function matchSender(db, fromAddress) {
  if (!fromAddress) return {}
  const normalized = String(fromAddress).trim().toLowerCase()
  if (!normalized) return {}

  const { rows: userRows } = await db.query(
    `SELECT entra_id, email, display_name FROM users_cache WHERE LOWER(email) = $1`,
    [normalized]
  )
  if (!userRows.length) return {}

  const u = userRows[0]

  // Device principal : on prend celui avec last_seen le plus récent.
  // Si le user n'a pas de device assigné, on retourne juste l'info user.
  const { rows: deviceRows } = await db.query(
    `SELECT id, hostname
     FROM devices
     WHERE assigned_user_id = $1
     ORDER BY last_seen DESC NULLS LAST
     LIMIT 1`,
    [u.entra_id]
  )

  return {
    user_id:         u.entra_id,
    user_email:      u.email,
    user_name:       u.display_name,
    device_id:       deviceRows[0]?.id        || null,
    device_hostname: deviceRows[0]?.hostname  || null,
  }
}
