import wingetPlugin  from './plugins/winget.js'
import agentWsPlugin from './plugins/agent-ws.js'

import devicesRoute       from './routes/devices.js'
import stockRoute         from './routes/stock.js'
import agentRoute         from './routes/agent.js'
import scriptsRoute       from './routes/scripts.js'
import packagesRoute      from './routes/packages.js'
import deploymentsRoute   from './routes/deployments.js'
import adminCredsRoute    from './routes/admin-credentials.js'

export default {
  name: 'inventory',
  requires: ['core'],
  async register(fastify) {
    // Plugins du module : enregistrés avant les routes qui les utilisent.
    await fastify.register(wingetPlugin)
    await fastify.register(agentWsPlugin)

    await fastify.register(devicesRoute,     { prefix: '/api/devices' })
    await fastify.register(stockRoute,       { prefix: '/api/stock' })
    await fastify.register(agentRoute,       { prefix: '/api/agent' })
    await fastify.register(scriptsRoute,     { prefix: '/api/scripts' })
    await fastify.register(packagesRoute,    { prefix: '/api/packages' })
    await fastify.register(deploymentsRoute, { prefix: '/api/deployments' })
    await fastify.register(adminCredsRoute,  { prefix: '/api/admin-credentials' })
  }
}
