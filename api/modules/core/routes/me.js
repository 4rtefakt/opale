import { validatePrefsPatch } from '../lib/prefs.js'

// Préférences de l'utilisateur courant (table user_prefs, JSONB). Authentifié
// simple (pas requireAdmin) : chaque user lit/écrit SES prefs. L'identité vient
// toujours du token via getUserIdentity — jamais d'id passé par le client.
export default async function meRoute(fastify) {

  // GET /api/me/prefs — le JSONB de l'utilisateur courant ({} si absent).
  fastify.get('/prefs', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { entraId } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(
      'SELECT prefs FROM user_prefs WHERE entra_id = $1', [entraId]
    )
    reply.send(rows[0]?.prefs ?? {})
  })

  // PATCH /api/me/prefs — merge superficiel des clés fournies (validées à la
  // frontière). Le `||` JSONB écrase clé par clé au niveau racine.
  fastify.patch('/prefs', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { ok, patch, error } = validatePrefsPatch(req.body)
    if (!ok) return reply.code(400).send({ error })

    const { entraId } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      INSERT INTO user_prefs (entra_id, prefs, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (entra_id) DO UPDATE SET
        prefs      = user_prefs.prefs || EXCLUDED.prefs,
        updated_at = now()
      RETURNING prefs
    `, [entraId, JSON.stringify(patch)])
    reply.send(rows[0].prefs)
  })
}
