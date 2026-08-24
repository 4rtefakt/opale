// Runner de migrations intégré — remplace l'application manuelle des
// fichiers 002+ documentée historiquement dans migrations/MIGRATIONS.md.
//
// Principe : les fichiers api/migrations/NNN_*.sql sont appliqués dans
// l'ordre alphabétique, chacun dans sa propre transaction, et tracés dans
// `schema_migrations`. Toutes les migrations sont idempotentes (la CI les
// rejoue deux fois pour le garantir), donc sur une instance existante qui
// n'a pas encore la table de suivi, tout rejouer est un no-op sûr.
//
// Un advisory lock sérialise les boots concurrents (plusieurs replicas ou
// un restart pendant l'apply) : le second boot attend, voit les migrations
// déjà tracées, et ne fait rien.

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const MIGRATION_LOCK_KEY = 727401  // arbitraire, stable — 'opale' migrations

export async function runMigrations(pool, log, dir) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)

    const files = (await readdir(dir))
      .filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
      .sort()

    const { rows } = await client.query('SELECT filename FROM schema_migrations')
    const done = new Set(rows.map(r => r.filename))

    let applied = 0
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)', [file]
        )
        await client.query('COMMIT')
        applied++
        log.info({ migration: file }, 'migration appliquée')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        // On s'arrête à la première migration en échec : continuer
        // appliquerait les suivantes sur un schéma incohérent.
        throw new Error(`migration ${file} échouée : ${err.message}`)
      }
    }

    log.info(
      { total: files.length, applied, skipped: files.length - applied },
      applied ? 'migrations à jour' : 'schéma déjà à jour'
    )
    return { total: files.length, applied }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => {})
    client.release()
  }
}
