import hardwareRequestsRoute from './routes/requests.js'

// Suivi des demandes de matériel et des commandes, à part des tickets
// (une demande peut pointer vers son ticket d'origine).
export default {
  name: 'hardware',
  requires: ['core', 'tickets'],
  async register(fastify) {
    await fastify.register(hardwareRequestsRoute, { prefix: '/api/hardware-requests' })
  },
}
