import alertsRoute       from './routes/alerts.js'
import alertSnoozesRoute from './routes/alert-snoozes.js'
import complianceRoute   from './routes/compliance.js'
import rapportsRoute     from './routes/rapports.js'
import networkRoute      from './routes/network.js'

export default {
  name: 'monitoring',
  requires: ['core', 'inventory'],
  async register(fastify) {
    await fastify.register(alertsRoute,       { prefix: '/api/alerts' })
    await fastify.register(alertSnoozesRoute, { prefix: '/api/alert-snoozes' })
    // compliance couvre /api/compliance ET /api/devices/:id/compliance.
    await fastify.register(complianceRoute,   { prefix: '/api' })
    await fastify.register(rapportsRoute,     { prefix: '/api/rapports' })
    await fastify.register(networkRoute,      { prefix: '/api/network' })
  }
}
