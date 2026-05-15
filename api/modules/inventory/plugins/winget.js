import fp from 'fastify-plugin'
import { WingetIndex } from '../lib/winget-index.js'

// Plugin Fastify : instancie l'index winget officiel (source.msix Microsoft),
// le rafraîchit en tâche de fond, et l'expose sur `fastify.winget`.
// Le démarrage de l'API n'est PAS bloqué par le téléchargement initial : si
// le CDN MS est indisponible, l'API démarre quand même et l'index sera
// chargé dès que possible. Les routes qui en dépendent renvoient 503 tant
// que l'index n'est pas prêt.
async function wingetPlugin(fastify) {
  const winget = new WingetIndex(fastify.log)
  fastify.decorate('winget', winget)
  fastify.addHook('onReady', async () => { winget.start() })
  fastify.addHook('onClose', async () => { winget.stop() })
}

export default fp(wingetPlugin)
