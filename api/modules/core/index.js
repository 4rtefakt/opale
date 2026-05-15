import envRoute       from './routes/env.js'
import brandingRoute  from './routes/branding.js'
import manifestRoute  from './routes/manifest.js'
import authRoute      from './routes/auth.js'
import usersRoute     from './routes/users.js'
import settingsRoute  from './routes/settings.js'
import dashboardRoute from './routes/dashboard.js'
import pushRoute      from './routes/push.js'

export default {
  name: 'core',
  requires: [],
  async register(fastify) {
    // env / branding / manifest s'enregistrent sans prefix : ils déclarent
    // leurs paths complets en interne.
    await fastify.register(envRoute)
    await fastify.register(brandingRoute)
    await fastify.register(manifestRoute)

    await fastify.register(authRoute,      { prefix: '/api/auth' })
    await fastify.register(usersRoute,     { prefix: '/api/users' })
    await fastify.register(settingsRoute,  { prefix: '/api/settings' })
    await fastify.register(dashboardRoute, { prefix: '/api/dashboard' })
    await fastify.register(pushRoute,      { prefix: '/api/push' })
  }
}
