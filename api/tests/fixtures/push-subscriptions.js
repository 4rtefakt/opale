// Fixtures réutilisables pour push_subscriptions.

export function makePushSubscription(endpoint = 'https://push.example.com/sub/test') {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: 'BXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      auth: 'XXXXXXXXXXXXXXXX',
    },
  }
}

export async function seedPushSubscription(db, {
  userEntraId = 'oid-push-user',
  endpoint = 'https://push.example.com/sub/seeded',
} = {}) {
  const subscription = makePushSubscription(endpoint)
  const { rows } = await db.query(
    `INSERT INTO push_subscriptions (user_entra_id, endpoint, subscription)
     VALUES ($1, $2, $3) RETURNING *`,
    [userEntraId, endpoint, JSON.stringify(subscription)]
  )
  return rows[0]
}
