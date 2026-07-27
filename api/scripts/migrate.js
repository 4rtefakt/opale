#!/usr/bin/env node
//
// CLI de migration — applique les migrations en attente puis sort.
//
//   node scripts/migrate.js              # applique ce qui manque
//   node scripts/migrate.js --status     # liste sans rien appliquer
//   node scripts/migrate.js --baseline 70
//
// Utile quand OPALE_MIGRATE_ON_BOOT=false (migration pilotée par
// l'orchestrateur plutôt que par le démarrage de l'API), ou pour inspecter
// l'état du schéma sans redémarrer le service.
//
// Se connecte avec les mêmes variables d'environnement que l'API
// (POSTGRES_HOST / _DB / _USER / _PASSWORD / _PORT / _SSLMODE).

import pg from 'pg'
import { buildPoolConfig } from '../lib/db-config.js'
import { listMigrations, runMigrations } from '../lib/migrate.js'

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const baselineIdx = args.indexOf('--baseline')
const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : process.env.OPALE_MIGRATIONS_BASELINE || null

const logger = {
  info:  (obj, msg) => console.log(msg || obj, msg ? obj : ''),
  warn:  (obj, msg) => console.warn(msg || obj, msg ? obj : ''),
  error: (obj, msg) => console.error(msg || obj, msg ? obj : ''),
}

const pool = new pg.Pool(buildPoolConfig())

try {
  if (statusOnly) {
    const files = await listMigrations()
    let applied = new Map()
    try {
      const { rows } = await pool.query('SELECT version, applied_at FROM schema_migrations')
      applied = new Map(rows.map(r => [r.version, r.applied_at]))
    } catch {
      console.log('(table schema_migrations absente — aucune migration tracée)')
    }
    let pending = 0
    for (const f of files) {
      const at = applied.get(f.version)
      if (at) {
        console.log(`  ✓ ${f.name}  (${new Date(at).toISOString()})`)
      } else {
        pending++
        console.log(`  · ${f.name}  EN ATTENTE`)
      }
    }
    console.log(`\n${files.length} migration(s), ${pending} en attente.`)
    process.exit(pending > 0 ? 1 : 0)
  }

  const res = await runMigrations(pool, { logger, baseline })
  console.log(
    `\n✓ ${res.applied.length} appliquée(s), ${res.skipped} déjà à jour` +
    (res.baselined.length ? `, ${res.baselined.length} baselinée(s)` : '') +
    `. Schéma courant : ${res.current}`
  )
  process.exit(0)
} catch (err) {
  console.error(`\n✗ Migration échouée : ${err.message}`)
  process.exit(1)
} finally {
  await pool.end().catch(() => {})
}
