import ticketsRoute         from './routes/tickets.js'
import ticketProposalsRoute from './routes/ticket-proposals.js'

export default {
  name: 'tickets',
  requires: ['core', 'inventory'],
  async register(fastify) {
    await fastify.register(ticketsRoute,         { prefix: '/api/tickets' })
    await fastify.register(ticketProposalsRoute, { prefix: '/api/ticket-proposals' })
  }
}
