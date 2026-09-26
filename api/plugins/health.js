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
// Les sondes concurrentes partagent la même requête en vol : un flot de
// requêtes sur cette route publique n'occupe jamais plus d'une connexion
// du pool.
const DB_CHECK_TIMEOUT_MS = 2000

async function healthPlugin(fastify, opts = {}) {
  const timeoutMs = opts.dbTimeoutMs ?? DB_CHECK_TIMEOUT_MS
  let inflight = null

  function checkDb() {
    if (inflight) return inflight
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pas de réponse en ${timeoutMs} ms`)), timeoutMs)
    })
    inflight = Promise.race([fastify.db.query('SELECT 1'), timeout])
      .finally(() => { clearTimeout(timer); inflight = null })
    return inflight
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
