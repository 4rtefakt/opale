// Seeds réutilisables pour la table devices. Le minimum vital pour qu'une
// route qui resolve un device par id puisse continuer (sans IP Netbird,
// sans health_signals etc. — les tests qui ont besoin de ces sous-tables
// les seedent eux-mêmes).

export async function seedDevice(db, {
  hostname = 'PC-TEST',
  serial = null,
  platform = null,
  managed_by = null,
  profile = null,
  ring = null,
  ipNetbird = null,
  lastSeenMinutesAgo = 0,
} = {}) {
  const last = new Date(Date.now() - lastSeenMinutesAgo * 60_000).toISOString()
  const r = await db.query(
    `INSERT INTO devices (hostname, ip_netbird, last_seen, serial, platform, managed_by, profile, ring)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, hostname`,
    [hostname, ipNetbird, last, serial, platform, managed_by, profile, ring]
  )
  return r.rows[0]
}
