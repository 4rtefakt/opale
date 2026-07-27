// Runner de migrations SQL pour Opale.
//
// Applique les fichiers `api/migrations/NNN_*.sql` dans l'ordre, une fois et
// une seule, en traçant l'état dans la table `schema_migrations`. Exécuté au
// boot de l'API (cf. index.js) et disponible en CLI (`node scripts/migrate.js`).
//
// Garanties :
//   • Sérialisation multi-instance via pg_advisory_lock — deux conteneurs qui
//     démarrent en même temps ne se marchent pas dessus, le second attend puis
//     constate qu'il n'y a rien à faire.
//   • Atomicité par fichier : chaque migration et l'INSERT dans
//     schema_migrations sont dans la MÊME transaction. Un échec au milieu ne
//     laisse ni schéma ni journal à moitié appliqués.
//   • Détection de dérive : le SHA-256 de chaque fichier appliqué est stocké.
//     Si un fichier déjà appliqué est modifié après coup, le boot échoue avec
//     un message explicite plutôt que de diverger silencieusement.
//   • Détection d'insertion rétroactive : une migration dont le numéro est
//     inférieur au plus haut déjà appliqué est signalée (warning), parce que
//     l'ordre relatif n'est alors plus celui qui a été testé.
//
// Adoption sur une instance existante (migrations appliquées à la main avant
// l'existence de ce runner) : les migrations Opale sont idempotentes — c'est
// un invariant vérifié en CI par la double passe de `validate-sql-migrations`.
// Les rejouer est donc un no-op, et l'instance se retrouve avec un
// schema_migrations correctement rempli. Pour les bases volumineuses où même
// un no-op coûte, OPALE_MIGRATIONS_BASELINE=<version> marque tout ce qui est
// ≤ version comme déjà appliqué sans exécuter le SQL.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')

// Clé du verrou consultatif Postgres. Constante arbitraire mais stable : elle
// n'a de sens que comparée à elle-même entre deux instances d'Opale.
const ADVISORY_LOCK_KEY = 4478562137

const FILENAME_RE = /^(\d+)_[a-z0-9_]+\.sql$/

function checksum(sql) {
  // Normalise les fins de ligne pour qu'un checkout Windows (CRLF) ne
  // produise pas une fausse dérive par rapport à un checkout Unix.
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

// Liste les migrations sur disque, triées par version croissante. Le tri est
// NUMÉRIQUE (pas alphabétique) : c'est ce qui rend un futur `100_x.sql`
// correctement ordonné après `099_y.sql`.
export async function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = await fs.readdir(dir)
  const files = []
  for (const name of entries) {
    if (!name.endsWith('.sql')) continue
    const m = FILENAME_RE.exec(name)
    if (!m) {
      throw new Error(
        `Migration mal nommée : « ${name} ». Format attendu : NNN_snake_case.sql ` +
        `(cf. api/migrations/MIGRATIONS.md).`
      )
    }
    files.push({ name, version: m[1], order: parseInt(m[1], 10) })
  }
  files.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  const seen = new Map()
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(
        `Deux migrations portent le numéro ${f.version} : « ${seen.get(f.version)} » et ` +
        `« ${f.name} ». L'ordre d'application serait ambigu — renommez-en une.`
      )
    }
    seen.set(f.version, f.name)
  }
  return files
}

async function ensureJournal(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        PRIMARY KEY,
      name        TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `)
}

/**
 * Applique les migrations en attente.
 *
 * @param {import('pg').Pool} pool
 * @param {object}   [opts]
 * @param {object}   [opts.logger]    - objet façon fastify.log (info/warn/error)
 * @param {string}   [opts.dir]       - répertoire des migrations
 * @param {string}   [opts.baseline]  - version ≤ laquelle tout est marqué appliqué sans exécution
 * @returns {Promise<{applied: string[], skipped: number, baselined: string[], current: string|null}>}
 */
export async function runMigrations(pool, { logger = console, dir = MIGRATIONS_DIR, baseline = null } = {}) {
  const files = await listMigrations(dir)
  if (!files.length) {
    throw new Error(`Aucune migration trouvée dans ${dir} — déploiement probablement incomplet.`)
  }

  // Un client dédié : les verrous consultatifs sont liés à la SESSION, donc
  // les prendre via pool.query() les poserait sur une connexion arbitraire
  // qui pourrait être recyclée avant le unlock.
  const client = await pool.connect()
  const applied = []
  const baselined = []
  let skipped = 0

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await ensureJournal(client)

    const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations')
    const journal = new Map(rows.map(r => [r.version, r]))

    // Baseline : marque comme appliqué sans exécuter. Réservé à l'adoption du
    // runner sur une instance dont le schéma est déjà à jour.
    if (baseline) {
      const cutoff = parseInt(baseline, 10)
      if (!Number.isFinite(cutoff)) {
        throw new Error(`OPALE_MIGRATIONS_BASELINE invalide : « ${baseline} » (entier attendu)`)
      }
      for (const f of files) {
        if (f.order > cutoff || journal.has(f.version)) continue
        const sql = await fs.readFile(path.join(dir, f.name), 'utf8')
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, 0) ON CONFLICT (version) DO NOTHING`,
          [f.version, f.name, checksum(sql)]
        )
        journal.set(f.version, { version: f.version, name: f.name, checksum: checksum(sql) })
        baselined.push(f.name)
      }
      if (baselined.length) {
        logger.warn(
          { count: baselined.length, baseline },
          'migrations : baseline appliquée — ces fichiers sont marqués appliqués SANS avoir été exécutés'
        )
      }
    }

    const highestApplied = rows.length
      ? Math.max(...rows.map(r => parseInt(r.version, 10)).filter(Number.isFinite))
      : -1

    for (const f of files) {
      const sql = await fs.readFile(path.join(dir, f.name), 'utf8')
      const sum = checksum(sql)
      const known = journal.get(f.version)

      if (known) {
        if (known.checksum !== sum) {
          throw new Error(
            `Migration ${f.name} modifiée après application (checksum ${known.checksum.slice(0, 12)}… ` +
            `en base, ${sum.slice(0, 12)}… sur disque).\n` +
            `Une migration appliquée est immuable : créez un nouveau fichier NNN+1 qui corrige, ` +
            `plutôt que d'éditer celui-ci.`
          )
        }
        skipped++
        continue
      }

      if (f.order < highestApplied) {
        logger.warn(
          { migration: f.name, highest_applied: highestApplied },
          'migrations : insertion rétroactive — cette migration a un numéro inférieur à des migrations déjà appliquées'
        )
      }

      const t0 = Date.now()
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)`,
          [f.version, f.name, sum, Date.now() - t0]
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(`Migration ${f.name} échouée : ${err.message}`)
      }
      applied.push(f.name)
      logger.info({ migration: f.name, duration_ms: Date.now() - t0 }, 'migrations : appliquée')
    }

    const current = files.length ? files[files.length - 1].version : null
    if (applied.length) {
      logger.info({ applied: applied.length, skipped, current }, 'migrations : schéma à jour')
    } else {
      logger.info({ skipped, current }, 'migrations : schéma déjà à jour')
    }
    return { applied, skipped, baselined, current }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {})
    client.release()
  }
}

// Version de schéma actuellement appliquée — exposée par GET /health.
// Retourne null si le journal n'existe pas encore (base jamais migrée).
export async function currentSchemaVersion(pool) {
  try {
    // Tri numérique explicite : `version` est TEXT (pour garder le zéro-padding
    // du nom de fichier), donc un ORDER BY lexicographique classerait '9'
    // après '100'. Les versions sont garanties numériques par FILENAME_RE.
    const { rows } = await pool.query(
      'SELECT version FROM schema_migrations ORDER BY version::int DESC LIMIT 1'
    )
    return rows[0]?.version ?? null
  } catch {
    return null
  }
}
