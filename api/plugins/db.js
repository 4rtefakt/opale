import fp from 'fastify-plugin'
import pg from 'pg'

async function dbPlugin(fastify) {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST || 'db',
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 10
  })

  await pool.query('SELECT 1')
  fastify.log.info('Base de données connectée')

  fastify.decorate('db', pool)
  fastify.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin)
