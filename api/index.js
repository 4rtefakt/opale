import crypto from 'crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import websocket from '@fastify/websocket'
import sensible from '@fastify/sensible'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

import dbPlugin           from './plugins/db.js'
import authPlugin         from './plugins/auth.js'
import cleanupPlugin      from './plugins/cleanup.js'
import errorHandlerPlugin from './plugins/error-handler.js'

import { loadModules, startModuleWorkers } from './lib/module-loader.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const CSP = "frame-ancestors 'self'"

const fastify = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' }
})

if (!process.env.SSH_USER) {
  fastify.log.warn(
    "SSH_USER non défini — utilisation du défaut 'opale'. " +
    "Définissez SSH_USER dans .env pour aligner sur l'utilisateur SSH réel de vos postes."
  )
}

// En prod, FRONTEND_URL DOIT être défini explicitement — sinon `origin: true`
// reflèterait n'importe quelle origine en Access-Control-Allow-Origin. En dev
// (NODE_ENV != production) on autorise le fallback permissif pour faciliter
// le travail local.
const corsOrigin = process.env.FRONTEND_URL
  || (process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('FRONTEND_URL requis en production (CORS)') })()
      : true)

await fastify.register(cors, {
  origin: corsOrigin,
  // @fastify/cors v11 a restreint les méthodes par défaut aux CORS-safelistées
  // (GET, HEAD, POST). On expose explicitement PUT/PATCH/DELETE qu'on utilise.
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE'
})

await fastify.register(staticFiles, {
  root: join(__dirname, 'front'),
  prefix: '/',
  setHeaders: (res) => res.setHeader('Content-Security-Policy', CSP)
})

// Rate-limit en mode opt-in : aucune route limitée par défaut, les routes
// sensibles déclarent leur quota via `config: { rateLimit: { max, timeWindow } }`.
// La clé combine IP + 16 hex du hash du Bearer pour limiter par couple
// (machine, token) — évite qu'un seul token spam une IP partagée sans
// borner les hits légitimes d'autres tokens depuis la même IP.
await fastify.register(rateLimit, {
  global: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || ''
    if (auth.startsWith('Bearer ')) {
      const hash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 16)
      return `${req.ip}|${hash}`
    }
    return req.ip
  },
  errorResponseBuilder: (req, ctx) => ({
    error: 'Trop de requêtes',
    retry_after_ms: ctx.ttl
  })
})

// Infrastructure framework : websocket, db, auth, cleanup, error-handler,
// sensible. Communs à tous les modules, enregistrés avant le chargement
// modulaire pour exposer leurs décorateurs (fastify.db, fastify.authenticate,
// fastify.httpErrors, etc.).
await fastify.register(websocket)
await fastify.register(dbPlugin)
await fastify.register(authPlugin)
await fastify.register(cleanupPlugin)
await fastify.register(errorHandlerPlugin)
await fastify.register(sensible)   // expose fastify.httpErrors.X()

// Chargement des modules activés (cf. modules.config.js).
const modules = await loadModules(fastify)

fastify.setNotFoundHandler((req, reply) => {
  if (!req.url.startsWith('/api')) {
    reply.header('Content-Security-Policy', CSP)
    return reply.sendFile('index.html')
  }
  reply.code(404).send({ error: 'Not found' })
})

const port = parseInt(process.env.PORT || '3010', 10)
await fastify.listen({ port, host: '0.0.0.0' })

// Workers / timers des modules — démarrés après listen().
startModuleWorkers(modules, fastify)

// Arrêt propre. Sans ces handlers, un `docker compose restart` coupait net les
// requêtes en vol, les sessions SSH et les WebSockets agent : les hooks
// onClose (fin du pool Postgres, arrêt des timers de cleanup, flush des
// buffers de session) n'étaient jamais exécutés.
//
// fastify.close() cesse d'accepter de nouvelles connexions, laisse les
// requêtes en cours se terminer, puis déclenche les onClose. Le délai de
// garde évite qu'une connexion longue durée (terminal SSH ouvert, WS agent)
// ne bloque l'arrêt indéfiniment — au-delà, on sort quand même.
const SHUTDOWN_GRACE_MS = parseInt(process.env.OPALE_SHUTDOWN_GRACE_MS || '15000', 10)
let shuttingDown = false

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return   // un second Ctrl-C ne doit pas relancer la séquence
    shuttingDown = true
    fastify.log.info({ signal }, 'arrêt demandé — fermeture propre en cours')

    const guard = setTimeout(() => {
      fastify.log.warn({ grace_ms: SHUTDOWN_GRACE_MS }, 'arrêt : délai de garde dépassé, sortie forcée')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    guard.unref()

    fastify.close()
      .then(() => { fastify.log.info('arrêt : terminé'); process.exit(0) })
      .catch((err) => { fastify.log.error({ err: err.message }, 'arrêt : échec'); process.exit(1) })
  })
}
