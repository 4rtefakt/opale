import consoleSessionsPlugin from './plugins/console-sessions.js'

import sshRoute            from './routes/ssh.js'
import consoleRoute        from './routes/console.js'
import remoteSessionsRoute from './routes/remote-sessions.js'

export default {
  name: 'remote',
  requires: ['core', 'inventory'],
  // optional: ['tickets']
  // — remote importe attachSystemEventToOpenTicketsOfDevice depuis tickets/lib.
  // La table tickets existe toujours en DB (migrations partagées), donc l'import
  // ne casse pas si tickets est désactivé : la fonction se contente de ne rien
  // trouver à attacher. Pas de garde nécessaire au boot.
  async register(fastify) {
    await fastify.register(consoleSessionsPlugin)

    await fastify.register(sshRoute,     { prefix: '/api/ssh' })
    await fastify.register(consoleRoute, { prefix: '/api/console' })
    // remote-sessions couvre /api/devices/:id/remote-sessions ET
    // /api/remote-sessions/:id/log : prefix /api, paths complets en interne.
    await fastify.register(remoteSessionsRoute, { prefix: '/api' })
  }
}
