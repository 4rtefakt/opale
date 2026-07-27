import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

import { listMigrations, runMigrations, currentSchemaVersion, MIGRATIONS_DIR } from '../../lib/migrate.js'
import { isDbAvailable } from '../helpers/db.js'

const silent = { info() {}, warn() {}, error() {} }

// ─── listMigrations : validation de nommage (pas de DB nécessaire) ─────────

async function tmpDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opale-mig-'))
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content)
  }
  return dir
}

test('listMigrations : trie numériquement, pas alphabétiquement', async () => {
  const dir = await tmpDir({
    '009_neuf.sql': 'SELECT 1;',
    '010_dix.sql':  'SELECT 1;',
    '100_cent.sql': 'SELECT 1;',
  })
  const files = await listMigrations(dir)
  assert.deepEqual(files.map(f => f.name), ['009_neuf.sql', '010_dix.sql', '100_cent.sql'])
})

test('listMigrations : rejette un nom hors convention', async () => {
  const dir = await tmpDir({ 'oops.sql': 'SELECT 1;' })
  await assert.rejects(() => listMigrations(dir), /mal nommée/)
})

test('listMigrations : rejette deux migrations au même numéro', async () => {
  const dir = await tmpDir({ '005_a.sql': 'SELECT 1;', '005_b.sql': 'SELECT 1;' })
  await assert.rejects(() => listMigrations(dir), /portent le numéro 005/)
})

test('listMigrations : le répertoire réel du repo est conforme', async () => {
  const files = await listMigrations(MIGRATIONS_DIR)
  assert.ok(files.length > 50, 'migrations du repo introuvables')
  const orders = files.map(f => f.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ordre non croissant')
})

// ─── runMigrations : comportement réel contre Postgres ────────────────────

const dbAvailable = isDbAvailable()

// Chaque test acquiert son propre schéma pour ne pas polluer les autres.
async function withSchema(fn) {
  const schema = `m_${crypto.randomBytes(6).toString('hex')}`
  const admin = new pg.Pool({ connectionString: process.env.PG_TEST_URL, max: 2 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({
    connectionString: process.env.PG_TEST_URL,
    max: 4,
    options: `-c search_path="${schema}"`,
  })
  try {
    return await fn(pool, schema)
  } finally {
    await pool.end().catch(() => {})
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
    await admin.end().catch(() => {})
  }
}

test('runMigrations : applique tout puis devient no-op', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS t_b (id int);',
    })

    const first = await runMigrations(pool, { logger: silent, dir })
    assert.equal(first.applied.length, 2)
    assert.equal(first.skipped, 0)
    assert.equal(first.current, '002')

    const second = await runMigrations(pool, { logger: silent, dir })
    assert.equal(second.applied.length, 0, 'un 2e run ne doit rien réappliquer')
    assert.equal(second.skipped, 2)

    assert.equal(await currentSchemaVersion(pool), '002')
  })
})

test('runMigrations : n\'applique que les nouveaux fichiers', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({ '001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int);' })
    await runMigrations(pool, { logger: silent, dir })

    await fs.writeFile(path.join(dir, '002_b.sql'), 'CREATE TABLE IF NOT EXISTS t_b (id int);')
    const res = await runMigrations(pool, { logger: silent, dir })

    assert.deepEqual(res.applied, ['002_b.sql'])
    assert.equal(res.skipped, 1)
  })
})

test('runMigrations : détecte une migration modifiée après application', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({ '001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int);' })
    await runMigrations(pool, { logger: silent, dir })

    await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE IF NOT EXISTS t_a (id int, extra text);')
    await assert.rejects(
      () => runMigrations(pool, { logger: silent, dir }),
      /modifiée après application/
    )
  })
})

test('runMigrations : une migration en échec ne laisse rien derrière elle', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({
      '001_ok.sql':  'CREATE TABLE IF NOT EXISTS t_ok (id int);',
      '002_bad.sql': 'CREATE TABLE t_bad (id int); SELECT cette_fonction_nexiste_pas();',
    })

    await assert.rejects(() => runMigrations(pool, { logger: silent, dir }), /002_bad\.sql échouée/)

    // La 1re est appliquée et tracée, la 2e n'a laissé ni table ni ligne.
    const { rows: journal } = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
    assert.deepEqual(journal.map(r => r.version), ['001'])

    const { rows: tables } = await pool.query(
      `SELECT to_regclass('t_bad') AS t`
    )
    assert.equal(tables[0].t, null, 'la table de la migration échouée doit avoir été rollbackée')
  })
})

test('runMigrations : baseline marque sans exécuter', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS t_b (id int);',
    })

    const res = await runMigrations(pool, { logger: silent, dir, baseline: '1' })
    assert.deepEqual(res.baselined, ['001_a.sql'])
    assert.deepEqual(res.applied, ['002_b.sql'])

    // 001 est marquée appliquée mais son SQL n'a jamais tourné.
    const { rows } = await pool.query(`SELECT to_regclass('t_a') AS a, to_regclass('t_b') AS b`)
    assert.equal(rows[0].a, null, 'la migration baselinée ne doit pas avoir été exécutée')
    assert.notEqual(rows[0].b, null)
  })
})

test('runMigrations : deux runs concurrents ne se marchent pas dessus', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const dir = await tmpDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id int);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS t_b (id int);',
    })

    // Le verrou consultatif doit sérialiser : chaque migration n'est appliquée
    // qu'une fois au total, et aucun run ne se termine en erreur de doublon.
    const [a, b] = await Promise.all([
      runMigrations(pool, { logger: silent, dir }),
      runMigrations(pool, { logger: silent, dir }),
    ])
    assert.equal(a.applied.length + b.applied.length, 2)

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM schema_migrations')
    assert.equal(rows[0].n, 2)
  })
})

test('runMigrations : applique la vraie suite du repo de bout en bout', { skip: !dbAvailable && 'PG_TEST_URL non défini' }, async () => {
  await withSchema(async (pool) => {
    const res = await runMigrations(pool, { logger: silent })
    assert.ok(res.applied.length > 50, `attendu >50 migrations, reçu ${res.applied.length}`)

    // Les tables qui manquaient à une install neuve avant l'existence du
    // runner doivent maintenant exister.
    for (const table of ['packages', 'deployments', 'remote_sessions', 'cli_tokens',
                         'device_admin_credentials', 'settings', 'ticket_attachments']) {
      const { rows } = await pool.query('SELECT to_regclass($1) AS t', [table])
      assert.notEqual(rows[0].t, null, `table ${table} absente après migration`)
    }

    const again = await runMigrations(pool, { logger: silent })
    assert.equal(again.applied.length, 0, 'la suite complète doit être stable au 2e run')
  })
})
