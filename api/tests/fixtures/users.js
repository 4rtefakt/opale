// Seeds réutilisables pour users_cache. Les routes API attendent
// systématiquement une row pour le user qui auth (cf.
// plugins/auth.js:requireAdmin → SELECT is_admin FROM users_cache).
// Sans ce seed, requireAdmin retourne 403 avant que la route soit
// atteinte → tous les tests qui visent à exercer un endpoint admin
// commenceraient à 403 et on perdrait le contrat testé.

export async function seedAdmin(db, {
  entraId = 'oid-admin-default',
  displayName = 'Admin Test',
  email = 'admin@test.local',
} = {}) {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (entra_id) DO UPDATE SET
       is_admin = true,
       display_name = EXCLUDED.display_name,
       email = EXCLUDED.email`,
    [entraId, displayName, email]
  )
  return { entraId, displayName, email }
}

export async function seedNonAdmin(db, {
  entraId = 'oid-nonadmin-default',
  displayName = 'NonAdmin Test',
  email = 'user@test.local',
} = {}) {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = false`,
    [entraId, displayName, email]
  )
  return { entraId, displayName, email }
}
