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

// Garde-fou montage Docker : si signing.key / laps.key n'existaient pas au
// premier `up`, Docker a créé des RÉPERTOIRES à leur place — état silencieux
// qui casse la signature des binaires et l'escrow LAPS. On échoue fort avec
// la marche à suivre plutôt que de laisser pourrir.
{
  const { statSync } = await import('fs')
  const agentKeys = [
    process.env.AGENT_SIGNING_KEY || join(__dirname, 'agent-go/keys/signing.key'),
    process.env.LAPS_PRIVATE_KEY  || join(__dirname, 'agent-go/keys/laps.key'),
  ]
  for (const p of agentKeys) {
    try {
      if (statSync(p).isDirectory()) {
        throw new Error(
          `${p} est un répertoire, pas une clé. Docker l'a créé parce que le ` +
          `fichier n'existait pas au premier démarrage. Supprimez-le, générez ` +
          `les clés (bash setup.sh) puis relancez.`
        )
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // Absente = OK : les clés sont optionnelles tant qu'on ne sert pas de
      // binaires agent ni d'escrow LAPS.
    }
  }
}

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

// Sonde de vie — utilisée par le healthcheck compose, le reverse proxy et
// tout orchestrateur. 200 si l'API et la DB répondent, 503 sinon.
fastify.get('/api/health', async (req, reply) => {
  try {
    await fastify.db.query('SELECT 1')
    return { status: 'ok' }
  } catch {
    return reply.code(503).send({ status: 'db_unavailable' })
  }
})

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

// Arrêt propre : docker stop envoie SIGTERM — on ferme les connexions HTTP/WS
// en cours et le pool pg (hooks onClose) au lieu de mourir mid-transaction.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    fastify.log.info({ sig }, 'signal reçu — arrêt propre')
    try {
      await fastify.close()
    } catch (err) {
      fastify.log.error({ err: err.message }, 'erreur pendant la fermeture')
    }
    process.exit(0)
  })
}
