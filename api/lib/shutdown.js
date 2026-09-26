// Arrêt propre sur SIGTERM / SIGINT (docker stop, `docker compose up -d` qui
// recrée le container, Ctrl-C).
//
// Sans handler, Node s'arrête net au signal : requêtes HTTP coupées en
// plein traitement, workers interrompus au milieu d'un tick (ex. mail
// réclamé mais résultat de l'envoi jamais enregistré), pool Postgres non
// fermé. Ici : fastify.close() — hook preClose d'abord (workers arrêtés
// après leur tick en cours, cf. module-loader.stopWorkersBeforeClose), plus
// de nouvelles connexions, requêtes en cours terminées, WebSockets fermées,
// puis hooks onClose (pool Postgres fermé) — et exit(0).
//
// Docker envoie SIGKILL 10 s après SIGTERM (stop_grace_period par défaut) :
// au-delà de `timeoutMs`, on sort en code 1 plutôt que d'être tué sans
// trace. Un second signal force la sortie immédiate.
//
// Connexions keep-alive (Caddy garde ses connexions amont ouvertes) : une
// connexion dont la requête était en cours au signal reste ouverte après la
// réponse, et server.close() l'attendrait jusqu'à keepAliveTimeout (72 s),
// bien au-delà de la sortie forcée. Pendant la fermeture, les connexions
// devenues inactives sont fermées toutes les 250 ms.
const IDLE_SWEEP_MS = 250

export function installShutdownHandlers(fastify, {
  signals = ['SIGTERM', 'SIGINT'],
  timeoutMs = 8000,
  exit = (code) => process.exit(code),
  proc = process,
} = {}) {
  let closing = false

  const onSignal = async (signal) => {
    if (closing) {
      fastify.log.warn({ signal }, 'arrêt : second signal, sortie immédiate')
      exit(1)
      return
    }
    closing = true
    fastify.log.info({ signal }, 'arrêt : fermeture propre en cours')
    // unref : le balayage seul ne doit jamais retenir le process.
    const sweep = setInterval(() => fastify.server?.closeIdleConnections?.(), IDLE_SWEEP_MS)
    sweep.unref?.()
    const timer = setTimeout(() => {
      clearInterval(sweep)
      fastify.log.error({ timeoutMs }, 'arrêt : délai dépassé, sortie forcée')
      exit(1)
    }, timeoutMs)
    try {
      await fastify.close()
      clearTimeout(timer)
      fastify.log.info('arrêt : terminé')
      exit(0)
    } catch (err) {
      clearTimeout(timer)
      fastify.log.error({ err: err.message }, 'arrêt : erreur pendant la fermeture')
      exit(1)
    } finally {
      clearInterval(sweep)
    }
  }

  for (const s of signals) proc.on(s, onSignal)
  return onSignal
}
