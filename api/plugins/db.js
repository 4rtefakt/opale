import fp from 'fastify-plugin'
import pg from 'pg'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { runMigrations } from '../lib/migrate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function dbPlugin(fastify) {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST || 'db',
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 10,
    // Une requête qui dépasse 30s est un bug ou un scan non borné — on la
    // tue plutôt que de laisser une famille de requêtes affamer le pool.
    statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000', 10)
  })

  // Le boot peut précéder la disponibilité du Postgres (docker compose démarre
  // les deux en parallèle malgré depends_on healthy sur certains setups) —
  // quelques retries évitent un crash-loop inutile.
  let lastErr
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query('SELECT 1')
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      fastify.log.warn({ attempt, err: err.message }, 'DB indisponible, retry dans 2s')
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  if (lastErr) throw lastErr
  fastify.log.info('Base de données connectée')

  // Migrations appliquées au boot (idempotentes, tracées dans
  // schema_migrations). Opt-out via MIGRATE_ON_BOOT=false pour les
  // déploiements qui préfèrent les appliquer manuellement.
  if (process.env.MIGRATE_ON_BOOT !== 'false') {
    await runMigrations(pool, fastify.log, join(__dirname, '../migrations'))
  }

  fastify.decorate('db', pool)
  fastify.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin)
