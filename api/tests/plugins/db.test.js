// Plugin db : migrations appliquées au démarrage, avant que la base ne soit
// exposée (fastify.db) ; échec de migration → l'API refuse de démarrer.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import pg from 'pg'

import dbPlugin from '../../plugins/db.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { listMigrationFiles } from '../../lib/migrations.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

after(closeSharedPool)

async function emptySchema(t) {
  const acquired = await acquireSchema({ migrate: false })
  t.after(acquired.release)
  return acquired
}

async function boot(t, opts, { logLines } = {}) {
  const app = Fastify({
    logger: logLines ? { level: 'warn', stream: { write: (l) => logLines.push(JSON.parse(l)) } } : false,
  })
  t.after(() => app.close())
  await app.register(dbPlugin, opts)
  await app.ready()
  return app
}

test('démarrage : toutes les migrations appliquées avant d’exposer fastify.db', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const app = await boot(t, { env: {}, connection })
  const files = await listMigrationFiles()
  const { rows } = await app.db.query('SELECT count(*)::int AS n FROM schema_migrations')
  assert.equal(rows[0].n, files.length)
  const { rows: snap } = await app.db.query(`SELECT to_regclass('deployment_snapshots') AS r`)
  assert.equal(snap[0].r, 'deployment_snapshots')
})

test('DB_AUTO_MIGRATE=false : aucune migration jouée', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const app = await boot(t, { env: { DB_AUTO_MIGRATE: 'false' }, connection })
  const { rows } = await app.db.query(`SELECT to_regclass('schema_migrations') AS r, to_regclass('devices') AS d`)
  assert.deepEqual(rows[0], { r: null, d: null })
})

test('migration en échec : le plugin (donc l’API) refuse de démarrer', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opale-mig-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, '001_bad.sql'), 'SELECT * FROM table_inexistante;')

  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await assert.rejects(
    (async () => { await app.register(dbPlugin, { env: {}, connection, migrationsDir: dir }); await app.ready() })(),
    /Migration 001_bad\.sql en échec/
  )
})

test('DB_AUTO_MIGRATE invalide : refus de démarrer', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await assert.rejects(
    (async () => { await app.register(dbPlugin, { env: { DB_AUTO_MIGRATE: 'peut-être' }, connection }); await app.ready() })(),
    /DB_AUTO_MIGRATE invalide/
  )
})

// ── Pool : erreurs de connexion inactive et timeouts ─────────────────────────

test('connexion inactive coupée côté Postgres : erreur journalisée, pas de crash, pool utilisable', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const logLines = []
  const app = await boot(t, { env: { DB_AUTO_MIGRATE: 'false' }, connection }, { logLines })

  // Une connexion rendue au pool (inactive), puis tuée par le serveur
  // (redémarrage Postgres, coupure réseau…).
  const client = await app.db.connect()
  const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid')
  client.release()
  const admin = new pg.Client({ connectionString: process.env.PG_TEST_URL })
  await admin.connect()
  t.after(() => admin.end())
  await admin.query('SELECT pg_terminate_backend($1)', [pid])
  await sleep(200)

  assert.ok(logLines.some(l => /db: connexion inactive/.test(l.msg)), 'erreur journalisée')
  const { rows } = await app.db.query('SELECT 1 AS ok')
  assert.equal(rows[0].ok, 1)
})

test('DB_STATEMENT_TIMEOUT_MS : une requête trop longue est interrompue (57014)', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const app = await boot(t, { env: { DB_AUTO_MIGRATE: 'false', DB_STATEMENT_TIMEOUT_MS: '200' }, connection })
  await assert.rejects(app.db.query('SELECT pg_sleep(1)'), (err) => err.code === '57014')
})

test('timeout de requête court : les migrations (connexion dédiée) ne sont pas concernées', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  // 1 ms suffirait à faire échouer n'importe quelle migration si le runner
  // héritait du statement_timeout du pool : le démarrage doit réussir.
  await boot(t, { env: { DB_STATEMENT_TIMEOUT_MS: '1' }, connection })
  const files = await listMigrationFiles()
  const check = new pg.Client(connection)   // relecture sans limite
  await check.connect()
  t.after(() => check.end())
  const { rows: [{ n }] } = await check.query('SELECT count(*)::int AS n FROM schema_migrations')
  assert.equal(n, files.length)
})

test('DB_CONNECTION_TIMEOUT_MS : Postgres qui ne répond pas → échec du démarrage en temps borné', { timeout: 5000 }, async (t) => {
  // Serveur TCP qui accepte puis ne répond jamais (hôte figé, pare-feu).
  const sockets = []
  const server = net.createServer((s) => sockets.push(s))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { sockets.forEach(s => s.destroy()); server.close() })

  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const t0 = Date.now()
  await assert.rejects((async () => {
    await app.register(dbPlugin, {
      env: { DB_CONNECTION_TIMEOUT_MS: '300' },
      connection: { host: '127.0.0.1', port: server.address().port, user: 'x', database: 'x' },
    })
    await app.ready()
  })())
  assert.ok(Date.now() - t0 < 3000)
})

test('valeur de timeout invalide : refus de démarrer', async (t) => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await assert.rejects(
    (async () => { await app.register(dbPlugin, { env: { DB_STATEMENT_TIMEOUT_MS: '30s' } }); await app.ready() })(),
    /DB_STATEMENT_TIMEOUT_MS invalide/
  )
})

test('client emprunté (pool.connect) dont le backend est tué en pleine transaction : le process survit', { skip: SKIP, timeout: 20000 }, () => {
  // Sans listener 'error' sur le client emprunté, Node arrête le process
  // (« Unhandled 'error' event ») : on l'exécute dans un processus enfant.
  const child = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/db-client-error-child.mjs')
  const r = spawnSync(process.execPath, [child], { env: process.env, encoding: 'utf8', timeout: 15000 })
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`)
  assert.match(r.stdout, /SURVIVED 1/)
})
