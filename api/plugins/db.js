import fp from 'fastify-plugin'
import pg from 'pg'

import { runMigrations, parseAutoMigrate } from '../lib/migrations.js'

// Timeouts du pool applicatif, en millisecondes, surchargeables par
// variable d'environnement (0 = pas de limite) :
//   DB_CONNECTION_TIMEOUT_MS : attente max pour obtenir une connexion (pool
//     plein, ou Postgres injoignable / qui ne répond pas). Sans limite, une
//     requête attendait indéfiniment.
//   DB_STATEMENT_TIMEOUT_MS  : durée max d'une requête côté Postgres
//     (statement_timeout) ; au-delà, erreur 57014 et connexion libérée.
// Le runner de migrations utilise sa propre connexion, sans statement_timeout.
const TIMEOUT_DEFAULTS = {
  DB_CONNECTION_TIMEOUT_MS: 10_000,
  DB_STATEMENT_TIMEOUT_MS:  30_000,
}

// Valeur invalide → erreur : on refuse de démarrer sur une config ambiguë.
export function parseTimeoutMs(env, name) {
  const raw = env[name]
  if (raw === undefined || String(raw).trim() === '') return TIMEOUT_DEFAULTS[name]
  const v = String(raw).trim()
  if (!/^\d+$/.test(v)) {
    throw new Error(`${name} invalide (${raw}) — attendu : un nombre de millisecondes (0 = sans limite)`)
  }
  return parseInt(v, 10)
}

// Options (tests uniquement) : `env` (défaut process.env), `connection`
// (surcharge la config de connexion pg), `migrationsDir`.
async function dbPlugin(fastify, opts = {}) {
  const env = opts.env || process.env
  // Validés avant toute connexion : valeur ambiguë → refus de démarrer.
  const autoMigrate = parseAutoMigrate(env.DB_AUTO_MIGRATE)
  const connectionTimeoutMillis = parseTimeoutMs(env, 'DB_CONNECTION_TIMEOUT_MS')
  const statementTimeoutMs = parseTimeoutMs(env, 'DB_STATEMENT_TIMEOUT_MS')

  const connection = {
    host: env.POSTGRES_HOST || 'db',
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    ...opts.connection,
  }
  const pool = new pg.Pool({
    ...connection,
    max: 10,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMs,
  })

  // Erreur sur une connexion INACTIVE du pool (Postgres redémarré, coupure
  // réseau, backend tué) : sans listener, l'événement 'error' non géré fait
  // tomber tout le process. Le pool écarte la connexion fautive et en ouvre
  // une nouvelle à la prochaine requête : on journalise seulement.
  pool.on('error', (err) => {
    fastify.log.error({ err: err.message, code: err.code },
      'db: connexion inactive du pool en erreur (écartée du pool)')
  })

  // Même risque pour un client EMPRUNTÉ (pool.connect() : transactions du
  // checkin, des tickets, du pont mail…) : pg-pool retire son listener à
  // l'emprunt, et un backend tué pendant la transaction (redémarrage
  // Postgres, pg_terminate_backend, coupure réseau) émettait un 'error' non
  // géré qui arrêtait l'API. Listener posé sur chaque nouvelle connexion :
  // la requête en cours échoue normalement (500 pour la route) et le client
  // cassé est écarté au release().
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      fastify.log.warn({ err: err.message, code: err.code },
        'db: connexion en erreur (écartée du pool)')
    })
  })

  try {
    await pool.query('SELECT 1')
    fastify.log.info('Base de données connectée')

    // Migrations AVANT decorate / chargement des modules / listen : aucune
    // route ne tourne sur un schéma en retard. Un échec fait échouer
    // l'enregistrement du plugin → l'API ne démarre pas (voulu).
    if (autoMigrate) {
      await runMigrations({ ...connection, connectionTimeoutMillis }, { dir: opts.migrationsDir, log: fastify.log })
    } else {
      fastify.log.warn('DB_AUTO_MIGRATE=false : migrations non appliquées au démarrage (à appliquer à la main)')
    }
  } catch (err) {
    await pool.end().catch(() => {})
    throw err
  }

  fastify.decorate('db', pool)
  fastify.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin)
