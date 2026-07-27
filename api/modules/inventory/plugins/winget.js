import fp from 'fastify-plugin'
import { WingetIndex } from '../lib/winget-index.js'

// Plugin Fastify : instancie l'index winget officiel (source2.msix Microsoft),
// le rafraîchit en tâche de fond, et l'expose sur `fastify.winget`.
// Le démarrage de l'API n'est PAS bloqué par le téléchargement initial : si
// le CDN MS est indisponible, l'API démarre quand même et l'index sera
// chargé dès que possible. Les routes qui en dépendent renvoient 503 tant
// que l'index n'est pas prêt.
//
// ── Opt-in délibéré ───────────────────────────────────────────────────────
// L'index pèse ~50 Mo de MSIX téléchargés, décompressés en mémoire, puis
// conservés sous forme de base SQLite chargée en WASM — plusieurs centaines
// de Mo résidents en permanence dans le process API, rafraîchis toutes les
// 24 h. C'est un coût considérable sur la VM unique de 10-200 postes que vise
// Opale, pour une fonctionnalité de confort : l'autocomplétion de noms de
// paquets. Un admin qui connaît l'identifiant winget qu'il veut déployer le
// saisit directement.
//
// Le défaut est donc « désactivé ». Pour l'activer :
//   OPALE_WINGET_INDEX=true
// Les routes de recherche répondent proprement `{ ready: false, results: [] }`
// quand il ne tourne pas — le front affiche un champ de saisie libre, pas une
// erreur.
export function wingetIndexEnabled(env = process.env) {
  return String(env.OPALE_WINGET_INDEX || '').toLowerCase() === 'true'
}

// Substitut inerte : même surface publique que WingetIndex, coût nul. Évite
// aux routes d'avoir à tester l'existence de `fastify.winget`.
const DISABLED_INDEX = {
  ready:       () => false,
  search:      () => ({ results: [] }),
  lastUpdated: null,
  start()      {},
  stop()       {},
}

async function wingetPlugin(fastify) {
  if (!wingetIndexEnabled()) {
    fastify.log.info(
      'winget : index désactivé (OPALE_WINGET_INDEX≠true). ' +
      'L\'autocomplétion de paquets est inactive ; la saisie directe d\'un identifiant winget fonctionne normalement.'
    )
    fastify.decorate('winget', DISABLED_INDEX)
    return
  }

  const winget = new WingetIndex(fastify.log)
  fastify.decorate('winget', winget)
  fastify.addHook('onReady', async () => { winget.start() })
  fastify.addHook('onClose', async () => { winget.stop() })
}

export default fp(wingetPlugin)
