// Runner de migrations de démarrage (lib/migrations.js).
//
// Couvre : base vide, base migrée à la main sans historique (tous fichiers,
// puis état prod « jusqu'à 070 »), runners concurrents (verrou consultatif),
// migration en échec (rollback + arrêt + reprise), fichier hors transaction,
// fichier modifié après application, et la variable DB_AUTO_MIGRATE.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedReplayHazards, assertReplayHazardsIntact } from '../helpers/populated-db.js'
import {
  runMigrations, listMigrationFiles, parseAutoMigrate, MIGRATIONS_DIR,
  isNoTransaction, findTransactionControl,
} from '../../lib/migrations.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

after(closeSharedPool)

async function emptySchema(t) {
  const acquired = await acquireSchema({ migrate: false })
  t.after(acquired.release)
  return acquired
}

// Application « à la main » (comme psql / la CI) : fichier entier en une
// requête, sans historique.
async function applyByHand(db, { upTo } = {}) {
  for (const f of await listMigrationFiles()) {
    if (upTo && f.name > upTo) break
    await db.query(f.sql)
  }
}

async function history(db) {
  const { rows } = await db.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename')
  return rows
}

async function tmpMigrations(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opale-mig-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  for (const [name, sql] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), sql)
  }
  return dir
}

function captureLog() {
  const entries = []
  const push = (level) => (obj, msg) => entries.push({ level, obj, msg })
  return { entries, info: push('info'), warn: push('warn'), error: push('error') }
}

test('base vide : chaque migration appliquée une fois et enregistrée, second passage sans effet', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  const files = await listMigrationFiles()

  const first = await runMigrations(connection)
  assert.deepEqual(first.applied, files.map(f => f.name))
  assert.deepEqual(await history(db), files.map(f => ({ filename: f.name, checksum: f.checksum })))

  const second = await runMigrations(connection)
  assert.deepEqual(second.applied, [])
  // Le schéma est complet (table de la dernière vague présente).
  const { rows } = await db.query(`SELECT to_regclass('deployment_snapshots') AS r`)
  assert.equal(rows[0].r, 'deployment_snapshots')
})

test('base migrée à la main (tous les fichiers, données réelles, sans historique) : rejeu sans erreur, historique complété, données intactes', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  await applyByHand(db)
  const seed = await seedReplayHazards(db)
  const files = await listMigrationFiles()

  const log = captureLog()
  const res = await runMigrations(connection, { log })
  assert.deepEqual(res.applied, files.map(f => f.name), 'tous les fichiers non enregistrés sont rejoués')
  assert.equal((await history(db)).length, files.length)
  assert.ok(log.entries.some(e => e.level === 'warn' && /sans historique/.test(e.msg)),
    'le rejeu initial sur une base existante est signalé')
  await assertReplayHazardsIntact(db, assert, seed)

  // Deuxième passage complet (comme la CI) sur la même base peuplée.
  await applyByHand(db)
  await assertReplayHazardsIntact(db, assert, seed)
})

test('base migrée à la main jusqu’à 070 (état prod) : 071 et 075 sont réellement exécutées', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  await applyByHand(db, { upTo: '070_user_prefs.sql' })
  assert.equal((await db.query(`SELECT to_regclass('deployment_snapshots') AS r`)).rows[0].r, null)

  // Données laissées par l'ancien code : déploiement pending d'un package
  // approuvé (sans snapshot), mot de passe temporaire stocké par l'onboarding.
  const { rows: [dev] } = await db.query(`INSERT INTO devices (hostname) VALUES ('PC-PROD-070') RETURNING id`)
  const { rows: [pkg] } = await db.query(`
    INSERT INTO packages (name, type, install_script, status)
    VALUES ('Pkg 070', 'script', 'Write-Output ok', 'approved') RETURNING id
  `)
  const { rows: [dep] } = await db.query(`
    INSERT INTO deployments (package_id, device_id) VALUES ($1, $2) RETURNING id
  `, [pkg.id, dev.id])
  const { rows: [ob] } = await db.query(`
    INSERT INTO onboardings (person_name, notes)
    VALUES ('Nouvel arrivant', E'Compte créé : na@example.com\\nMot de passe temporaire : Abcd!2345xyzQ') RETURNING id
  `)
  await db.query(`
    INSERT INTO onboarding_checks (onboarding_id, step_id, label, auto_result)
    VALUES ($1, 'create_account', 'Compte', '{"id":"u1","temporaryPassword":"Abcd!2345xyzQ"}')
  `, [ob.id])

  const res = await runMigrations(connection)
  assert.ok(res.applied.includes('071_deployment_snapshots.sql'))
  assert.ok(res.applied.includes('075_strip_onboarding_temp_passwords.sql'))

  const { rows: snaps } = await db.query(`SELECT install_script FROM deployment_snapshots WHERE deployment_id = $1`, [dep.id])
  assert.deepEqual(snaps, [{ install_script: 'Write-Output ok' }], '071 a figé le pending existant')
  const { rows: [o] } = await db.query(`SELECT notes FROM onboardings WHERE id = $1`, [ob.id])
  assert.doesNotMatch(o.notes, /Abcd!2345xyzQ/, '075 a purgé le mot de passe des notes')
  const { rows: [c] } = await db.query(`SELECT auto_result FROM onboarding_checks WHERE onboarding_id = $1`, [ob.id])
  assert.doesNotMatch(c.auto_result, /temporaryPassword/, '075 a purgé auto_result')
  const names = (await history(db)).map(r => r.filename)
  assert.ok(names.includes('071_deployment_snapshots.sql') && names.includes('075_strip_onboarding_temp_passwords.sql'))
})

test('runners concurrents : verrou consultatif, chaque fichier exécuté une seule fois', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  // Fichiers volontairement NON idempotents : un double passage échouerait.
  const dir = await tmpMigrations(t, {
    '001_probe.sql': 'CREATE TABLE lock_probe (id int); SELECT pg_sleep(0.3);',
    '002_probe_row.sql': 'INSERT INTO lock_probe VALUES (1);',
  })
  const [a, b] = await Promise.all([
    runMigrations(connection, { dir }),
    runMigrations(connection, { dir }),
  ])
  assert.deepEqual([...a.applied, ...b.applied].sort(), ['001_probe.sql', '002_probe_row.sql'])
  const { rows } = await db.query('SELECT count(*)::int AS n FROM lock_probe')
  assert.equal(rows[0].n, 1)
})

test('migration en échec : rollback du fichier, arrêt, erreur explicite, reprise au passage suivant', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  const dir = await tmpMigrations(t, {
    '001_ok.sql': 'CREATE TABLE ok_t (id int);',
    '002_bad.sql': 'CREATE TABLE bad_t (id int);\nSELECT * FROM table_inexistante;',
    '003_after.sql': 'CREATE TABLE after_t (id int);',
  })
  await assert.rejects(runMigrations(connection, { dir }), (err) => {
    assert.match(err.message, /002_bad\.sql/)
    assert.match(err.message, /ligne 2/)
    assert.match(err.message, /42P01/)
    return true
  })
  const reg = async (n) => (await db.query('SELECT to_regclass($1) AS r', [n])).rows[0].r
  assert.equal(await reg('ok_t'), 'ok_t')
  assert.equal(await reg('bad_t'), null, 'le fichier en échec est annulé en entier')
  assert.equal(await reg('after_t'), null, 'les fichiers suivants ne sont pas joués')
  assert.deepEqual((await history(db)).map(r => r.filename), ['001_ok.sql'])

  // Fichier corrigé : le passage suivant reprend là où il s'était arrêté.
  await fs.writeFile(path.join(dir, '002_bad.sql'), 'CREATE TABLE bad_t (id int);')
  const res = await runMigrations(connection, { dir })
  assert.deepEqual(res.applied, ['002_bad.sql', '003_after.sql'])
})

test('fichier « -- opale:no-transaction » : exécuté hors transaction (CREATE INDEX CONCURRENTLY)', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  const dir = await tmpMigrations(t, {
    '001_table.sql': 'CREATE TABLE cc_t (id int);',
    '002_index.sql': 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cc_t ON cc_t (id);',
  })
  // Sans la directive : Postgres refuse dans une transaction.
  await assert.rejects(runMigrations(connection, { dir }), /002_index\.sql.*25001/)

  await fs.writeFile(path.join(dir, '002_index.sql'),
    '-- opale:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cc_t ON cc_t (id);')
  const res = await runMigrations(connection, { dir })
  assert.deepEqual(res.applied, ['002_index.sql'])
  const { rows } = await db.query(`SELECT to_regclass('idx_cc_t') AS r`)
  assert.equal(rows[0].r, 'idx_cc_t')
})

test('fichier modifié après application : signalé, pas rejoué', { skip: SKIP }, async (t) => {
  const { connection } = await emptySchema(t)
  const dir = await tmpMigrations(t, { '001_a.sql': 'CREATE TABLE drift_t (id int);' })
  await runMigrations(connection, { dir })
  await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE drift_t (id int); -- retouché')
  const log = captureLog()
  const res = await runMigrations(connection, { dir, log })
  assert.deepEqual(res.applied, [])
  assert.ok(log.entries.some(e => e.level === 'warn' && e.obj?.files?.includes('001_a.sql')))
})

test('MIGRATIONS_DIR : seuls les fichiers NNN_*.sql, dans l’ordre', async () => {
  const files = await listMigrationFiles(MIGRATIONS_DIR)
  const names = files.map(f => f.name)
  assert.ok(names.length > 60)
  assert.deepEqual(names, [...names].sort())
  assert.ok(!names.includes('MIGRATIONS.md'))
  assert.equal(names[0], '001_init.sql')
  // Aucune migration du repo n'a besoin d'être hors transaction aujourd'hui.
  assert.deepEqual(files.filter(f => !f.transactional).map(f => f.name), [])
})

test('parseAutoMigrate : défaut actif, désactivable, valeur ambiguë refusée', () => {
  for (const v of [undefined, '', 'true', '1', 'on', 'YES']) assert.equal(parseAutoMigrate(v), true, String(v))
  for (const v of ['false', '0', 'off', 'No']) assert.equal(parseAutoMigrate(v), false, v)
  assert.throws(() => parseAutoMigrate('fasle'), /DB_AUTO_MIGRATE invalide/)
})

// ── Durcissements (revue) ────────────────────────────────────────────────────

test('volume neuf (seul 001 joué par l’entrypoint Postgres, aucune donnée) : pas d’avertissement « sans historique »', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  await applyByHand(db, { upTo: '001_init.sql' })
  const log = captureLog()
  const res = await runMigrations(connection, { log })
  assert.ok(res.applied.length > 60)
  assert.ok(!log.entries.some(e => e.level === 'warn'), JSON.stringify(log.entries.filter(e => e.level === 'warn')))
})

test('directive no-transaction : seule sur sa ligne, dans l’en-tête du fichier', () => {
  assert.equal(isNoTransaction('-- opale:no-transaction\nCREATE INDEX CONCURRENTLY x ON t (id);'), true)
  assert.equal(isNoTransaction('-- Index sur t\n\n--   opale:no-transaction  \nCREATE INDEX CONCURRENTLY x ON t (id);'), true)
  // Prose qui mentionne la directive : pas une directive.
  assert.equal(isNoTransaction('-- opale:no-transaction n’est pas nécessaire ici\nCREATE TABLE t (id int);'), false)
  // Après le premier ordre SQL : ignorée.
  assert.equal(isNoTransaction('CREATE TABLE t (id int);\n-- opale:no-transaction\n'), false)
})

test('ordre BEGIN / COMMIT au niveau du fichier : détecté (hors blocs DO, chaînes et commentaires)', async () => {
  assert.equal(findTransactionControl('BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;'), 'BEGIN')
  assert.equal(findTransactionControl('CREATE TABLE t (id int);\ncommit;'), 'commit')
  assert.equal(findTransactionControl('START TRANSACTION; SELECT 1;'), 'START TRANSACTION')
  // Faux positifs à éviter : corps PL/pgSQL, chaînes, commentaires.
  assert.equal(findTransactionControl("DO $$ BEGIN PERFORM 1; END $$;"), null)
  assert.equal(findTransactionControl("DO $body$\nBEGIN\n  NULL;\nEND\n$body$;"), null)
  assert.equal(findTransactionControl("INSERT INTO s VALUES ('x; COMMIT; y');"), null)
  assert.equal(findTransactionControl("-- BEGIN; COMMIT;\n/* ROLLBACK; */ SELECT 1;"), null)
  assert.equal(findTransactionControl("SELECT E'it\\'s; COMMIT';"), null)
  // Aucune migration du repo n'en contient.
  for (const f of await listMigrationFiles(MIGRATIONS_DIR)) {
    assert.equal(findTransactionControl(f.sql), null, f.name)
  }
})

test('fichier en attente avec BEGIN / COMMIT : refus explicite, AUCUN fichier appliqué', { skip: SKIP }, async (t) => {
  const { db, connection } = await emptySchema(t)
  const dir = await tmpMigrations(t, {
    '001_ok.sql': 'CREATE TABLE ok_t (id int);',
    '002_tx.sql': 'BEGIN;\nCREATE TABLE tx_t (id int);\nCOMMIT;',
  })
  await assert.rejects(runMigrations(connection, { dir }), /002_tx\.sql.*BEGIN/)
  const reg = async (n) => (await db.query('SELECT to_regclass($1) AS r', [n])).rows[0].r
  assert.equal(await reg('ok_t'), null, 'rien appliqué avant le refus')
  assert.equal(await reg('tx_t'), null)
})
