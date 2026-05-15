// Seeds réutilisables pour la table devices. Le minimum vital pour qu'une
// route qui resolve un device par id puisse continuer (sans IP Netbird,
// sans health_signals etc. — les tests qui ont besoin de ces sous-tables
// les seedent eux-mêmes).

export async function seedDevice(db, {
  hostname = 'PC-TEST',
  ipNetbird = null,
  lastSeenMinutesAgo = 0,
} = {}) {
  const last = new Date(Date.now() - lastSeenMinutesAgo * 60_000).toISOString()
  const r = await db.query(
    `INSERT INTO devices (hostname, ip_netbird, last_seen)
     VALUES ($1, $2, $3) RETURNING id, hostname`,
    [hostname, ipNetbird, last]
  )
  return r.rows[0]
}
