#!/usr/bin/env node
// Applique les migrations en attente avec le runner du démarrage de l'API
// (lib/migrations.js : transaction par fichier, schema_migrations, verrou
// consultatif) SANS démarrer l'API ni ses workers (aucun mail envoyé, aucun
// appel Graph). Usages :
//   - répéter le premier démarrage sur une copie restaurée de la base de
//     prod (cf. INSTALL.md) :
//       docker compose run --rm --no-deps -e POSTGRES_DB=opale_rehearsal \
//         api node scripts/run-migrations.js
//   - instances en DB_AUTO_MIGRATE=false qui appliquent à la main.
//
// Connexion : DATABASE_URL (ou PGURL), sinon POSTGRES_HOST / POSTGRES_DB /
// POSTGRES_USER / POSTGRES_PASSWORD (comme l'API). Code de sortie 0 si la
// base est à jour, 1 sinon (message de l'échec sur stderr).

import { runMigrations } from '../lib/migrations.js'

const url = process.env.DATABASE_URL || process.env.PGURL
const connection = url
  ? { connectionString: url }
  : {
      host:     process.env.POSTGRES_HOST || 'db',
      database: process.env.POSTGRES_DB,
      user:     process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    }

const print = (stream) => (obj, msg) => stream.write(
  `${msg ?? ''}${obj && typeof obj === 'object' ? ' ' + JSON.stringify(obj) : ''}\n`)
const log = { info: print(process.stdout), warn: print(process.stderr), error: print(process.stderr) }

try {
  const res = await runMigrations(connection, { log })
  console.log(`${res.applied.length} migration(s) appliquée(s), ${res.total} au total`)
  process.exit(0)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
