import fp from 'fastify-plugin'
import pg from 'pg'
import { buildPoolConfig } from '../lib/db-config.js'
import { runMigrations, currentSchemaVersion } from '../lib/migrate.js'

async function dbPlugin(fastify) {
  const pool = new pg.Pool(buildPoolConfig())

  // Un pool ne remonte les erreurs de connexion que sur les requêtes ; sans ce
  // handler, une coupure réseau côté client inactif émet un 'error' non
  // capturé qui tue le process. On logge et on laisse pg recycler le client.
  pool.on('error', (err) => {
    fastify.log.error({ err: err.message }, 'pool pg : erreur sur un client inactif')
  })

  await pool.query('SELECT 1')
  fastify.log.info('Base de données connectée')

  // Migrations au boot — avant que la moindre route ne soit servie. Un échec
  // ici DOIT empêcher le démarrage : servir l'API sur un schéma incomplet
  // produit des 500 diffus bien plus difficiles à diagnostiquer qu'un refus
  // de démarrer explicite.
  if (process.env.OPALE_MIGRATE_ON_BOOT !== 'false') {
    await runMigrations(pool, {
      logger:   fastify.log,
      baseline: process.env.OPALE_MIGRATIONS_BASELINE || null,
    })
  } else {
    fastify.log.warn(
      'OPALE_MIGRATE_ON_BOOT=false — migrations non appliquées au boot. ' +
      'Lancez `node scripts/migrate.js` avant de servir du trafic.'
    )
  }

  fastify.decorate('db', pool)
  fastify.decorate('schemaVersion', () => currentSchemaVersion(pool))
  fastify.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin)
