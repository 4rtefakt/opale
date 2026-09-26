// scripts/run-migrations.js : runner de migrations en ligne de commande
// (répétition du premier démarrage sur une copie de prod, instances en
// DB_AUTO_MIGRATE=false). Exécuté en processus enfant, comme en prod.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { listMigrationFiles } from '../../lib/migrations.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/run-migrations.js')

after(closeSharedPool)

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60000 })
}

test('base vide : toutes les migrations appliquées, code 0 ; second passage sans effet', { skip: SKIP }, async (t) => {
  const { db, schema, release } = await acquireSchema({ migrate: false })
  t.after(release)
  // PGOPTIONS (lu par pg) : même isolation par schéma que les autres suites.
  const env = { DATABASE_URL: process.env.PG_TEST_URL, PGOPTIONS: `-c search_path="${schema}"` }
  const files = await listMigrationFiles()

  const first = run(env)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, new RegExp(`${files.length} migration\\(s\\) appliquée\\(s\\)`))
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM schema_migrations')
  assert.equal(n, files.length)

  const second = run(env)
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /0 migration\(s\) appliquée\(s\)/)
})

test('base injoignable : code 1 et message', () => {
  const r = run({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ECONNREFUSED|connect/)
})
