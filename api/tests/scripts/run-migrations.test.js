// scripts/run-migrations.js : runner de migrations en ligne de commande
// (répétition du premier démarrage sur une copie de prod, instances en
// DB_AUTO_MIGRATE=false). Exécuté en processus enfant, comme en prod.
//
// Cible : --database <nom> obligatoire et vérifié contre la connexion
// résolue — une DATABASE_URL (prioritaire) oubliée dans .env ne doit jamais
// détourner une répétition vers la base de production.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { listMigrationFiles } from '../../lib/migrations.js'
import { resolveTarget } from '../../scripts/run-migrations.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/run-migrations.js')

after(closeSharedPool)

function run(env, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60000 })
}

const testDbName = () => new URL(process.env.PG_TEST_URL).pathname.slice(1)

test('base vide : cible affichée, toutes les migrations appliquées, code 0 ; second passage sans effet', { skip: SKIP }, async (t) => {
  const { db, schema, release } = await acquireSchema({ migrate: false })
  t.after(release)
  // PGOPTIONS (lu par pg) : même isolation par schéma que les autres suites.
  const env = { DATABASE_URL: process.env.PG_TEST_URL, PGOPTIONS: `-c search_path="${schema}"` }
  const files = await listMigrationFiles()

  const first = run(env, ['--database', testDbName()])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, new RegExp(`^Cible : [^\\n]*/${testDbName()} \\(utilisateur [^\\n]*via DATABASE_URL\\)`, 'm'))
  const cible = first.stdout.split('\n').find(l => l.startsWith('Cible : '))
  const password = decodeURIComponent(new URL(process.env.PG_TEST_URL).password)
  assert.ok(!cible.includes('@') && !cible.includes(`:${password}`), `jamais le mot de passe : ${cible}`)
  assert.match(first.stdout, new RegExp(`${files.length} migration\\(s\\) appliquée\\(s\\)`))
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM schema_migrations')
  assert.equal(n, files.length)

  const second = run(env, ['--database', testDbName()])
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /0 migration\(s\) appliquée\(s\)/)
})

test('DATABASE_URL vers une autre base que --database (répétition détournée vers la prod) : refus, rien migré', { skip: SKIP }, async (t) => {
  const { db, schema, release } = await acquireSchema({ migrate: false })
  t.after(release)
  // .env de prod : DATABASE_URL → base « prod » (ici la base de test) ;
  // la répétition ne surcharge que POSTGRES_DB.
  const r = run({
    DATABASE_URL: process.env.PG_TEST_URL, PGOPTIONS: `-c search_path="${schema}"`,
    POSTGRES_DB: 'opale_rehearsal',
  }, ['--database', 'opale_rehearsal'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /DATABASE_URL pointe vers la base « .+ » \(.+\), pas « opale_rehearsal »/)
  assert.match(r.stderr, /-e DATABASE_URL= -e PGURL=/)
  const { rows } = await db.query(`SELECT to_regclass('schema_migrations') AS r, to_regclass('devices') AS d`)
  assert.deepEqual(rows[0], { r: null, d: null }, 'aucune migration appliquée')
})

test('--database absent : refus (code 2)', () => {
  const r = run({ POSTGRES_DB: 'opale' }, [])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--database <nom> requis/)
})

test('base injoignable : code 1 et message', () => {
  const r = run({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' }, ['--database', 'none'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Cible : 127\.0\.0\.1:1\/none/)
  assert.match(r.stderr, /ECONNREFUSED|connect/)
})

test('resolveTarget : règles de résolution de la cible', () => {
  // POSTGRES_* : la base est celle de --database, POSTGRES_DB doit concorder.
  const ok = resolveTarget({ POSTGRES_HOST: 'db', POSTGRES_DB: 'opale', POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p' }, ['--database', 'opale'])
  assert.deepEqual(ok.connection, { host: 'db', database: 'opale', user: 'u', password: 'p' })
  assert.equal(ok.target.source, 'POSTGRES_*')
  assert.throws(() => resolveTarget({ POSTGRES_DB: 'opale' }, ['--database', 'opale_rehearsal']), /POSTGRES_DB vaut « opale »/)
  // DATABASE_URL puis PGURL, prioritaires ; base vérifiée.
  const viaUrl = resolveTarget({ DATABASE_URL: 'postgres://u:secret@h:6543/opale_rehearsal' }, ['--database', 'opale_rehearsal'])
  assert.deepEqual(viaUrl.target, { source: 'DATABASE_URL', host: 'h', port: '6543', database: 'opale_rehearsal', user: 'u' })
  assert.throws(() => resolveTarget({ PGURL: 'postgres://u@h/opale', POSTGRES_DB: 'x' }, ['--database', 'x']), /PGURL pointe vers la base « opale »/)
  // Variable présente mais vide (docker compose run -e DATABASE_URL=) : ignorée.
  assert.equal(resolveTarget({ DATABASE_URL: '', PGURL: '', POSTGRES_DB: 'r' }, ['--database', 'r']).target.source, 'POSTGRES_*')
  assert.throws(() => resolveTarget({}, ['--database']), /--database <nom> requis/)
})
