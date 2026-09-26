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
// CONCURRENTLY…) : ligne `-- opale:no-transaction`, seule sur sa ligne, dans
// l'en-tête du fichier (commentaires avant le premier ordre SQL). Il est
// alors envoyé tel quel, hors transaction (un seul ordre par fichier).
//
// Un fichier contenant lui-même BEGIN / COMMIT (hors blocs PL/pgSQL) est
// refusé : il casserait la transaction du runner (fichier à moitié validé,
// enregistrement hors transaction).
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

// Directive « -- opale:no-transaction » : seule sur sa ligne, dans l'en-tête
// (lignes vides ou de commentaire avant le premier ordre SQL). Une mention
// dans un commentaire de prose, ou après du SQL, n'est pas une directive.
export function isNoTransaction(sql) {
  for (const raw of sql.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('--')) return false
    if (/^--\s*opale:no-transaction$/.test(line)) return true
  }
  return false
}

// Remplace commentaires, chaînes ('…', E'…', "…") et corps $tag$…$tag$ par
// des blancs : il ne reste que le SQL « de premier niveau ».
function topLevelSql(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1]
    if (c === '-' && n === '-') {
      const j = sql.indexOf('\n', i)
      i = j === -1 ? sql.length : j
      continue
    }
    if (c === '/' && n === '*') {
      const j = sql.indexOf('*/', i + 2)
      i = j === -1 ? sql.length : j + 2
      out += ' '
      continue
    }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i - 2] || '')
      let j = i + 1
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue }
          break
        }
        j++
      }
      i = j + 1
      out += ' '
      continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const j = sql.indexOf(m[0], i + m[0].length)
        i = j === -1 ? sql.length : j + m[0].length
        out += ' '
        continue
      }
    }
    out += c
    i++
  }
  return out
}

// Premier ordre de contrôle de transaction de premier niveau (BEGIN, START
// TRANSACTION, COMMIT, END, ROLLBACK, ABORT), ou null.
export function findTransactionControl(sql) {
  for (const stmt of topLevelSql(sql).split(';')) {
    const m = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i.exec(stmt)
    if (m) return m[1]
  }
  return null
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const names = (await fs.readdir(dir)).filter(f => FILE_RE.test(f)).sort()
  const files = []
  for (const name of names) {
    const sql = await fs.readFile(path.join(dir, name), 'utf8')
    files.push({ name, sql, checksum: sha256(sql), transactional: !isNoTransaction(sql) })
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
  // Base « en service » : des données existent (utilisateurs ou postes). Un
  // volume neuf où l'entrypoint Postgres n'a joué que 001 n'en a pas.
  let hasData = false
  if (state.has_schema) {
    const { rows: [d] } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM users_cache) OR EXISTS (SELECT 1 FROM devices) AS has_data
    `)
    hasData = d.has_data
  }
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

  // Refus explicite AVANT d'appliquer quoi que ce soit.
  for (const file of pending) {
    const stmt = findTransactionControl(file.sql)
    if (stmt) {
      const e = new Error(
        `Migration ${file.name} refusée : ordre « ${stmt} » au niveau du fichier — ` +
        'le runner encadre déjà chaque fichier dans une transaction ; retirer cet ordre (cf. MIGRATIONS.md)')
      e.migration = file.name
      throw e
    }
  }

  if (!state.has_history && hasData && pending.length) {
    log?.warn({ count: pending.length },
      'migrations : base existante sans historique (schema_migrations absente) — ' +
      'toutes les migrations vont être rejouées (idempotentes), puis enregistrées')
  } else if (!state.has_history && pending.length) {
    log?.info({ count: pending.length }, 'migrations : base neuve — application de toutes les migrations')
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
