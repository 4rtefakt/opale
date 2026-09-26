// Runner de migrations SQL, exécuté au démarrage de l'API (plugins/db.js),
// AVANT que le serveur n'écoute : une route ne voit jamais un schéma en
// retard sur le code (ex. checkin en 500 tant que 071 n'était pas passée à
// la main).
//
// Principe : chaque fichier `api/migrations/NNN_*.sql` absent de la table
// `schema_migrations` est exécuté, dans l'ordre alphabétique, chacun dans sa
// propre transaction, puis enregistré (dans la même transaction). Au premier
// échec : ROLLBACK du fichier, arrêt, erreur explicite → l'API refuse de
// démarrer (le restart Docker relance, les fichiers déjà passés restent
// acquis).
//
// Base existante migrée à la main (pas de schema_migrations) : il n'y a PAS
// de « baseline » qui marquerait des fichiers comme appliqués sans les
// exécuter — on ne peut pas savoir ce qui a réellement été joué (la prod peut
// être à n'importe quel état passé, et 075 par exemple DOIT s'exécuter pour
// purger les mots de passe). Tous les fichiers non enregistrés sont donc
// (re)joués : c'est sûr parce que chaque migration doit être idempotente, y
// compris sur une base peuplée (cf. api/migrations/MIGRATIONS.md et
// tests/lib/migrations-replay.test.js), puis l'historique est enregistré.
//
// Concurrence : verrou consultatif de session (pg_advisory_lock) propre au
// schéma courant. Un second runner (2e réplique, redémarrage rapide) attend,
// relit l'historique une fois le verrou obtenu et ne rejoue rien.
//
// Fichier ne pouvant pas tourner dans une transaction (CREATE INDEX
// CONCURRENTLY…) : ligne `-- opale:no-transaction` dans le fichier. Il est
// alors envoyé tel quel, hors transaction (un seul ordre par fichier).
//
// Désactivable : DB_AUTO_MIGRATE=false (migrations appliquées à la main).

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')

const FILE_RE = /^\d+_.*\.sql$/
const NO_TX_RE = /^[ \t]*--[ \t]*opale:no-transaction\b/m

// Clé du verrou consultatif : (hash constant, hash du schéma courant). Deux
// schémas (suites de tests) ne se bloquent pas entre eux ; en prod, un seul.
const LOCK_SQL_ARGS = `hashtext('opale:schema_migrations'), hashtext(coalesce(current_schema(), ''))`

// Attente maximale d'un verrou de table pendant une migration : plutôt que
// de rester bloqué indéfiniment derrière une session ouverte (psql oublié,
// pg_dump…), on échoue avec un message clair — le restart relancera.
const LOCK_TIMEOUT = '60s'

// DB_AUTO_MIGRATE : absent / '' / true / 1 / yes / on → true (défaut) ;
// false / 0 / no / off → false. Toute autre valeur lève : on refuse de
// démarrer sur une config ambiguë.
export function parseAutoMigrate(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v || ['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  throw new Error(`DB_AUTO_MIGRATE invalide (${raw}) — attendu : true ou false`)
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const names = (await fs.readdir(dir)).filter(f => FILE_RE.test(f)).sort()
  const files = []
  for (const name of names) {
    const sql = await fs.readFile(path.join(dir, name), 'utf8')
    files.push({ name, sql, checksum: sha256(sql), transactional: !NO_TX_RE.test(sql) })
  }
  return files
}

// Erreur de migration lisible : fichier, ligne (si Postgres donne une
// position), code SQLSTATE.
function migrationError(file, err) {
  let where = ''
  const pos = Number(err.position)
  if (Number.isInteger(pos) && pos > 0) {
    where = ` (ligne ${file.sql.slice(0, pos - 1).split('\n').length})`
  }
  const code = err.code ? ` [${err.code}]` : ''
  const e = new Error(`Migration ${file.name} en échec${where}${code} : ${err.message}`, { cause: err })
  e.code = err.code
  e.migration = file.name
  return e
}

async function applyPending(client, files, log) {
  const { rows: [state] } = await client.query(`
    SELECT to_regclass('schema_migrations') IS NOT NULL AS has_history,
           to_regclass('users_cache')       IS NOT NULL AS has_schema
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `)
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations')
  const applied = new Map(rows.map(r => [r.filename, r.checksum]))

  // Fichier modifié après application : pas rejoué (l'historique fait foi),
  // mais signalé — une correction de migration passée doit faire l'objet
  // d'un nouveau fichier.
  const drifted = files.filter(f => applied.has(f.name) && applied.get(f.name) !== f.checksum)
  if (drifted.length) {
    log?.warn({ files: drifted.map(f => f.name) },
      'migrations : fichier(s) modifié(s) depuis leur application — non rejoué(s)')
  }

  const pending = files.filter(f => !applied.has(f.name))
  if (!state.has_history && state.has_schema && pending.length) {
    log?.warn({ count: pending.length },
      'migrations : base existante sans historique (schema_migrations absente) — ' +
      'toutes les migrations vont être rejouées (idempotentes), puis enregistrées')
  }

  for (const file of pending) {
    const t0 = Date.now()
    try {
      if (file.transactional) {
        await client.query('BEGIN')
        await client.query(file.sql)
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, Date.now() - t0]
        )
        await client.query('COMMIT')
      } else {
        await client.query(file.sql)
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, Date.now() - t0]
        )
      }
    } catch (err) {
      if (file.transactional) await client.query('ROLLBACK').catch(() => {})
      throw migrationError(file, err)
    }
    log?.info({ migration: file.name, ms: Date.now() - t0 }, 'migration appliquée')
  }

  return { applied: pending.map(f => f.name), total: files.length }
}

// Applique les migrations en attente. `connection` : config pg.Client
// (host/database/user/password, ou connectionString + options). Le runner
// ouvre sa propre connexion : pas de statement_timeout du pool applicatif
// (une migration peut être longue), et le verrou consultatif vit le temps
// de la session.
export async function runMigrations(connection, { dir = MIGRATIONS_DIR, log } = {}) {
  const files = await listMigrationFiles(dir)
  const client = new pg.Client(connection)
  // Erreur réseau asynchrone sur la connexion dédiée : sans listener, le
  // process tomberait ; la requête en cours échoue de toute façon.
  client.on('error', (err) => log?.warn({ err: err.message }, 'migrations : erreur de connexion'))
  await client.connect()
  try {
    await client.query('SET statement_timeout = 0')
    await client.query('SET idle_in_transaction_session_timeout = 0')
    await client.query('SET lock_timeout = 0')
    await client.query(`SELECT pg_advisory_lock(${LOCK_SQL_ARGS})`)
    try {
      await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`)
      const result = await applyPending(client, files, log)
      if (result.applied.length) {
        log?.info({ applied: result.applied.length, total: result.total }, 'migrations : base à jour')
      } else {
        log?.info({ total: result.total }, 'migrations : aucune migration en attente')
      }
      return result
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_SQL_ARGS})`).catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
}
