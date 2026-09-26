// Processus enfant de tests/plugins/db.test.js (pas un fichier de test).
//
// Emprunte un client au pool du plugin db (pool.connect(), comme les
// transactions du checkin), ouvre une transaction, fait tuer son backend
// pendant une requête active (redémarrage Postgres, pg_terminate_backend,
// coupure réseau), puis vérifie que le process et le pool survivent.
// Sans listener 'error' sur le client emprunté, pg.Client émet un 'error'
// non géré et Node arrête le process (exit 1).

import Fastify from 'fastify'
import dbPlugin from '../../plugins/db.js'

const app = Fastify({ logger: false })
await app.register(dbPlugin, {
  env: { DB_AUTO_MIGRATE: 'false' },
  connection: { connectionString: process.env.PG_TEST_URL },
})
await app.ready()

const client = await app.db.connect()
const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid')
await client.query('BEGIN')
setTimeout(() => {
  app.db.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => {})
}, 200)
try {
  await client.query('SELECT pg_sleep(3)')
} catch (err) {
  console.log('requête rejetée :', err.message)
}
await client.query('ROLLBACK').catch(() => {})
client.release()
await new Promise((r) => setTimeout(r, 500))

const { rows } = await app.db.query('SELECT 1 AS ok')
console.log(`SURVIVED ${rows[0].ok}`)
await app.close()
