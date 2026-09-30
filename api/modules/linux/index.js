import { operations } from './lib/spec.js'
import agentRoutes from './routes/agent.js'
import enrollmentsRoutes from './routes/enrollments.js'
import preregistrationsRoutes from './routes/preregistrations.js'
import devicesRoutes from './routes/devices.js'

// Passe à true quand toutes les opérations de la spec sont enregistrées
// (le test de parité exige alors spec ⊆ routes, et plus seulement routes ⊆ spec).
export const SPEC_COMPLETE = false

export default {
  name: 'linux',
  requires: ['core', 'inventory'],
  async register(fastify) {
    // Chaque route porte config: { operationId } pour le test de parité,
    // et schema: schemaFor(operationId) pour rester fidèle à la spec.
    await fastify.register(agentRoutes,            { prefix: '/api/linux/agent' })
    await fastify.register(enrollmentsRoutes,      { prefix: '/api/linux' })
    await fastify.register(preregistrationsRoutes, { prefix: '/api/linux' })
    await fastify.register(devicesRoutes,          { prefix: '/api/linux' })
    fastify.log.info(`[linux] Module chargé, enrôlement actif (${operations().length} opérations dans la spec)`)
  },
}
