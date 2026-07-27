// GET /health — sonde de vivacité pour Docker, reverse-proxy et supervision.
//
// Non authentifié (une sonde n'a pas de jeton) et donc volontairement avare :
// on confirme que le process répond et que la base est joignable, on expose la
// version de schéma appliquée — utile pour diagnostiquer un déploiement où le
// code et la base ont divergé — et rien d'autre. Ni versions de dépendances,
// ni configuration, ni détail d'erreur : un 503 nu suffit à la sonde, le
// diagnostic vit dans les logs serveur.
//
// Réponse 200 : { status: 'ok', schema_version: '070', uptime_s: 1234 }
// Réponse 503 : { status: 'degraded' }

const startedAt = Date.now()

export default async function healthRoute(fastify) {
  fastify.get('/health', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await fastify.db.query('SELECT 1')
    } catch (err) {
      req.log.error({ err: err.message }, 'health : base injoignable')
      return reply.code(503).send({ status: 'degraded' })
    }
    return {
      status:         'ok',
      schema_version: await fastify.schemaVersion?.() ?? null,
      uptime_s:       Math.floor((Date.now() - startedAt) / 1000),
    }
  })
}
