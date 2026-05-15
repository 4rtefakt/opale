import fp from 'fastify-plugin'
import { ConsoleSessionsRegistry } from '../lib/console-sessions.js'

// Plugin qui instancie la registry des sessions console-via-agent et la
// décore sur fastify (`fastify.consoleSessions`). Dépend de `agent-ws`
// (besoin de fastify.agentWs et de son event `disconnect`).
//
// Côté graceful shutdown : close toutes les sessions actives. Le close
// propage console.close à l'agent + remet end_reason='server-shutdown'
// dans remote_sessions, ce qui évite les rows "ended_at NULL" orphelines.
async function consoleSessionsPlugin(fastify) {
  const registry = new ConsoleSessionsRegistry({
    log:     fastify.log,
    db:      fastify.db,
    agentWs: fastify.agentWs,
  })
  fastify.decorate('consoleSessions', registry)

  fastify.addHook('onClose', async () => {
    const ids = [...registry.sessions.keys()]
    for (const id of ids) {
      await registry.close(id, 'server-shutdown')
    }
  })
}

export default fp(consoleSessionsPlugin, {
  name: 'console-sessions',
  dependencies: ['agent-ws'],
})
