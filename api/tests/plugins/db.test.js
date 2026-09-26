// Plugin db : migrations appliquées au démarrage, avant que la base ne soit
// exposée (fastify.db) ; échec de migration → l'API refuse de démarrer.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

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

async function boot(t, opts) {
  const app = Fastify({ logger: false })
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
