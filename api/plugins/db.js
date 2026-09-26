import fp from 'fastify-plugin'
import pg from 'pg'

import { runMigrations, parseAutoMigrate } from '../lib/migrations.js'

// Options (tests uniquement) : `env` (défaut process.env), `connection`
// (surcharge la config de connexion pg), `migrationsDir`.
async function dbPlugin(fastify, opts = {}) {
  const env = opts.env || process.env
  // Validé avant toute connexion : valeur ambiguë → refus de démarrer.
  const autoMigrate = parseAutoMigrate(env.DB_AUTO_MIGRATE)

  const connection = {
    host: env.POSTGRES_HOST || 'db',
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    ...opts.connection,
  }
  const pool = new pg.Pool({ ...connection, max: 10 })

  try {
    await pool.query('SELECT 1')
    fastify.log.info('Base de données connectée')

    // Migrations AVANT decorate / chargement des modules / listen : aucune
    // route ne tourne sur un schéma en retard. Un échec fait échouer
    // l'enregistrement du plugin → l'API ne démarre pas (voulu).
    if (autoMigrate) {
      await runMigrations(connection, { dir: opts.migrationsDir, log: fastify.log })
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
