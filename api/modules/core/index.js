import envRoute       from './routes/env.js'
import brandingRoute  from './routes/branding.js'
import manifestRoute  from './routes/manifest.js'
import authRoute      from './routes/auth.js'
import usersRoute     from './routes/users.js'
import settingsRoute  from './routes/settings.js'
import dashboardRoute from './routes/dashboard.js'
import pushRoute      from './routes/push.js'
import meRoute        from './routes/me.js'
import healthRoute    from './routes/health.js'

import { warnIfNoAdmin } from './lib/bootstrap-admin.js'

export default {
  name: 'core',
  requires: [],
  async register(fastify) {
    // env / branding / manifest s'enregistrent sans prefix : ils déclarent
    // leurs paths complets en interne.
    // health se déclare sans prefix (path complet /health) — les sondes
    // Docker/proxy ne connaissent pas le préfixe /api.
    await fastify.register(healthRoute)
    await fastify.register(envRoute)
    await fastify.register(brandingRoute)
    await fastify.register(manifestRoute)

    await fastify.register(authRoute,      { prefix: '/api/auth' })
    await fastify.register(usersRoute,     { prefix: '/api/users' })
    await fastify.register(settingsRoute,  { prefix: '/api/settings' })
    await fastify.register(dashboardRoute, { prefix: '/api/dashboard' })
    await fastify.register(pushRoute,      { prefix: '/api/push' })
    await fastify.register(meRoute,        { prefix: '/api/me' })

    // Avertit tant que l'instance n'a aucun administrateur (cf.
    // lib/bootstrap-admin.js). onReady : la base est connectée et migrée.
    //
    // Le corps est en accolades — donc renvoie `undefined` — et PAS
    // `() => warnIfNoAdmin(…)` : Fastify interprète la valeur résolue d'un
    // hook onReady comme une erreur, et `warnIfNoAdmin` retourne un booléen.
    // Sans ça, le seul cas où l'avertissement est utile (aucun admin → true)
    // faisait échouer le démarrage.
    fastify.addHook('onReady', async () => { await warnIfNoAdmin(fastify.db, fastify.log) })
  }
}
