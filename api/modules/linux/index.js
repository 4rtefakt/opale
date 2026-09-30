import { operations } from './lib/spec.js'

export const SPEC_COMPLETE = false

export default {
  name: 'linux',
  requires: ['core', 'inventory'],
  async register(fastify) {
    // Chaque future route doit porter config: { operationId } pour le test de parité,
    // et schema: schemaFor(operationId) pour rester fidèle à la spec.
    fastify.log.info(`[linux] Module chargé, ${operations().length} opérations de la spec en attente`)
  },
}
