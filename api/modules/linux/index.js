import { operations } from './lib/spec.js'
import { createGitMirror } from './lib/git-mirror.js'
import { createGitTokenStore } from './lib/git-token-store.js'
import agentRoutes from './routes/agent.js'
import enrollmentsRoutes from './routes/enrollments.js'
import preregistrationsRoutes from './routes/preregistrations.js'
import devicesRoutes from './routes/devices.js'
import gitAgentRoutes, { gitAdminRoutes } from './routes/git.js'
import settingsRoutes from './routes/settings.js'
import escrowRoutes from './routes/escrow.js'

// Passe à true quand toutes les opérations de la spec sont enregistrées
// (le test de parité exige alors spec ⊆ routes, et plus seulement routes ⊆ spec).
export const SPEC_COMPLETE = true

export default {
  name: 'linux',
  requires: ['core', 'inventory'],
  async register(fastify) {
    // Miroir git et tokens git : partagés avec les routes de check-in (émission des tokens, heads()).
    fastify.decorate('gitMirror', createGitMirror())
    fastify.decorate('gitTokenStore', createGitTokenStore())

    // Chaque route porte config: { operationId } pour le test de parité,
    // et schema: schemaFor(operationId) pour rester fidèle à la spec.
    await fastify.register(agentRoutes,            { prefix: '/api/linux/agent' })
    await fastify.register(gitAgentRoutes,         { prefix: '/api/linux/agent/git' })
    await fastify.register(enrollmentsRoutes,      { prefix: '/api/linux' })
    await fastify.register(preregistrationsRoutes, { prefix: '/api/linux' })
    await fastify.register(devicesRoutes,          { prefix: '/api/linux' })
    await fastify.register(gitAdminRoutes,         { prefix: '/api/linux' })
    await fastify.register(settingsRoutes,         { prefix: '/api/linux' })
    await fastify.register(escrowRoutes,           { prefix: '/api/linux' })
    fastify.log.info(`[linux] Module chargé, enrôlement et miroir git actifs (${operations().length} opérations dans la spec)`)
  },
  // Après listen() : le clone/fetch ne retarde jamais le démarrage de l'API.
  startWorkers(fastify) {
    fastify.gitMirror.start(fastify.db, fastify.log)
  },
  async stopWorkers(fastify) {
    fastify.gitMirror.stop()
    fastify.gitTokenStore.stop()
  },
}
