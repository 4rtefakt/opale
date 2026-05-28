import askRoute from './routes/ask.js'

export default {
  name: 'ask',
  // monitoring : on lit le set de règles de conformité (RULES) pour le
  // catalogue. tickets/groups : ciblés par les cross-filters et le résolveur.
  requires: ['core', 'inventory', 'monitoring', 'tickets', 'groups'],
  async register(fastify) {
    await fastify.register(askRoute, { prefix: '/api/ask' })
  },
}
