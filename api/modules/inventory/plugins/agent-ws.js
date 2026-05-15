import fp from 'fastify-plugin'
import { AgentWSRegistry } from '../lib/agent-ws.js'

// Plugin Fastify qui instancie la registry des connexions WS agent ↔ serveur
// et la décore sur l'instance (`fastify.agentWs`). Wrappé avec `fastify-plugin`
// pour que la décoration soit visible des routes peer (`routes/agent.js`,
// `routes/console.js` à venir).
//
// Le cycle de vie suit l'instance Fastify : sur close, on ferme toutes les
// connexions actives proprement pour éviter les sockets zombies pendant un
// graceful shutdown (k8s, docker stop, etc.).
async function agentWsPlugin(fastify) {
  const registry = new AgentWSRegistry(fastify.log)
  fastify.decorate('agentWs', registry)

  // Centralisation de l'audit log des disconnects superseded : émis par
  // register() avant le close, donc avant que le onClose du handler ws ne
  // fire (et peut-être ne fire jamais si le peer a déjà coupé). Les autres
  // cas (close normal, 1006, heartbeat, etc.) restent gérés par le onClose
  // du handler car le code WS n'est connu qu'à ce moment-là.
  registry.on('disconnect', (deviceId, conn, info) => {
    if (info?.reason !== 'superseded') return
    const durationSeconds = Math.round((Date.now() - (conn.connectedAt || Date.now())) / 1000)
    fastify.db.query(
      `INSERT INTO audit_logs (action, by_user, target, details)
       VALUES ('agent_ws_disconnect', $1, $2, $3)`,
      [conn.hostname, deviceId, JSON.stringify({
        code: info.code,
        reason: 'superseded',
        duration_seconds: durationSeconds,
        token_id: conn.tokenId,
      })]
    ).catch(err => fastify.log.warn({ err: err.message }, 'agent_ws_disconnect (superseded) audit failed'))
  })

  fastify.addHook('onClose', async () => {
    for (const [, conn] of registry.conns) {
      conn.close(1001, 'server-shutdown')
    }
    registry.conns.clear()
  })
}

export default fp(agentWsPlugin, { name: 'agent-ws' })
