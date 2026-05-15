// Factory Fastify minimaliste pour tester les plugins/routes en isolation.
// Le plugin db.js du repo se connecte à POSTGRES_HOST au boot — on shunte
// en décorant `fastify.db` directement avec le pool fourni (issu de
// acquireSchema() en général). Permet de re-utiliser la même factory pour
// des tests unit (db mock) ou intégration (db réel).
//
// Le logger est silencieux par défaut (les tests crachent moins).
// `options.routes` est appelé avec l'instance Fastify après les plugins,
// pour permettre au caller d'ajouter des routes de test inline (ex: une
// route minimaliste qui exerce `fastify.authenticate` en preHandler).

import Fastify from 'fastify'
import authPlugin from '../../plugins/auth.js'

export async function buildApp({ db, jwks, decorators = {}, registerAuth = true, routes } = {}) {
  const fastify = Fastify({ logger: false })
  fastify.decorate('db', db)
  for (const [name, value] of Object.entries(decorators)) {
    fastify.decorate(name, value)
  }
  if (registerAuth) {
    await fastify.register(authPlugin, { jwks })
  }
  if (typeof routes === 'function') {
    await routes(fastify)
  }
  await fastify.ready()
  return fastify
}
