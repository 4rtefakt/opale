import webpush from 'web-push'

let _vapidConfigured = false

function initVapid() {
  if (_vapidConfigured) return
  const pub  = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return
  const mail = process.env.VAPID_EMAIL
  if (!mail) {
    throw new Error(
      'VAPID_EMAIL est requis dès lors que VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY sont définis. ' +
      "Définissez-le dans .env (ex: VAPID_EMAIL=admin@example.com)."
    )
  }
  const subject = mail.startsWith('mailto:') ? mail : `mailto:${mail}`
  webpush.setVapidDetails(subject, pub, priv)
  _vapidConfigured = true
}

// Envoi d'une notification push à tous les admins abonnés
export async function sendPushToAll(fastify, payload) {
  initVapid()
  if (!_vapidConfigured) return

  const { rows } = await fastify.db.query(`SELECT subscription FROM push_subscriptions`)
  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload))
    } catch (err) {
      // 410 Gone = subscription expirée → supprimer
      if (err.statusCode === 410) {
        await fastify.db.query(
          `DELETE FROM push_subscriptions WHERE endpoint = $1`,
          [row.subscription.endpoint]
        ).catch(() => {})
      } else {
        fastify.log.warn({ err: err.message }, 'push sendNotification failed')
      }
    }
  }
}

export default async function pushRoute(fastify) {
  initVapid()

  // GET /api/push/vapid-public — clé publique pour le frontend
  fastify.get('/vapid-public', async (req, reply) => {
    const key = process.env.VAPID_PUBLIC_KEY
    if (!key) return reply.code(503).send({ error: 'Push notifications non configurées' })
    reply.send({ publicKey: key })
  })

  // POST /api/push/subscribe — enregistrer une souscription
  fastify.post('/subscribe', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { entraId } = fastify.getUserIdentity(req)
    const { subscription } = req.body || {}
    if (!subscription?.endpoint) return reply.code(400).send({ error: 'subscription invalide' })

    await fastify.db.query(`
      INSERT INTO push_subscriptions (user_entra_id, endpoint, subscription)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_entra_id, endpoint) DO UPDATE SET subscription = $3
    `, [entraId, subscription.endpoint, JSON.stringify(subscription)])

    reply.code(201).send({ ok: true })
  })

  // DELETE /api/push/subscribe — se désabonner
  fastify.delete('/subscribe', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { entraId } = fastify.getUserIdentity(req)
    const { endpoint } = req.body || {}
    if (!endpoint) return reply.code(400).send({ error: 'endpoint requis' })

    await fastify.db.query(`
      DELETE FROM push_subscriptions WHERE user_entra_id = $1 AND endpoint = $2
    `, [entraId, endpoint])

    reply.code(204).send()
  })
}
