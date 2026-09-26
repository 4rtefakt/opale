import fp from 'fastify-plugin'

// GET /api/health — sonde de disponibilité (healthcheck Docker, supervision,
// reverse proxy). Sans authentification : ne renvoie AUCUNE information
// sensible (ni version, ni message d'erreur, ni détail de la base) :
//   200 { status: 'ok' }           l'API répond et Postgres aussi ;
//   503 { status: 'unavailable' }  Postgres en erreur ou muet au-delà de
//                                   DB_CHECK_TIMEOUT_MS (cause dans les logs).
// Sous /api : hors du fallback SPA (qui répond index.html en 200 à toute
// URL inconnue hors /api, ce qui fausserait une sonde sur /health).
//
// Les sondes partagent la même requête en vol, et celle-ci reste suivie
// jusqu'à ce qu'elle se termine VRAIMENT (le délai ne borne que la réponse
// de chaque sonde) : un flot de requêtes sur cette route publique, même
// pendant un ralentissement de Postgres, n'occupe jamais plus d'une
// connexion du pool.
const DB_CHECK_TIMEOUT_MS = 2000

async function healthPlugin(fastify, opts = {}) {
  const timeoutMs = opts.dbTimeoutMs ?? DB_CHECK_TIMEOUT_MS
  let inflight = null

  function dbQuery() {
    if (!inflight) {
      inflight = fastify.db.query('SELECT 1').finally(() => { inflight = null })
    }
    return inflight
  }

  function checkDb() {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pas de réponse en ${timeoutMs} ms`)), timeoutMs)
    })
    return Promise.race([dbQuery(), timeout]).finally(() => clearTimeout(timer))
  }

  fastify.get('/api/health', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await checkDb()
      return { status: 'ok' }
    } catch (err) {
      req.log.warn({ err: err.message }, 'health: base de données indisponible')
      return reply.code(503).send({ status: 'unavailable' })
    }
  })
}

export default fp(healthPlugin)
