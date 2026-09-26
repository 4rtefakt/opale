#!/usr/bin/env node
// Applique les migrations en attente avec le runner du démarrage de l'API
// (lib/migrations.js : transaction par fichier, schema_migrations, verrou
// consultatif) SANS démarrer l'API ni ses workers (aucun mail envoyé, aucun
// appel Graph). Usages :
//   - répéter le premier démarrage sur une copie restaurée de la base de
//     prod (cf. INSTALL.md) :
//       docker compose run --rm --no-deps \
//         -e DATABASE_URL= -e PGURL= -e POSTGRES_DB=opale_rehearsal \
//         api node scripts/run-migrations.js --database opale_rehearsal
//   - instances en DB_AUTO_MIGRATE=false qui appliquent à la main.
//
// Cible : DATABASE_URL (ou PGURL) si défini, sinon POSTGRES_HOST /
// POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD (comme les autres scripts
// de maintenance). `--database <nom>` est OBLIGATOIRE et doit correspondre à
// la base ainsi résolue : sinon refus (code 2), sans rien toucher. Une
// DATABASE_URL oubliée dans .env ne peut donc pas détourner une répétition
// vers la base de production. La cible (hôte, port, base, utilisateur ; sans
// mot de passe) est affichée avant toute action.
//
// Codes de sortie : 0 base à jour, 1 échec de migration / connexion,
// 2 cible refusée ou arguments invalides.

import { pathToFileURL } from 'node:url'
import { runMigrations } from '../lib/migrations.js'

// Résout la cible. Retourne { connection, target } ou lève une Error dont
// le message explique le refus.
export function resolveTarget(env, argv) {
  const i = argv.indexOf('--database')
  const wanted = i >= 0 ? argv[i + 1] : undefined
  if (!wanted || wanted.startsWith('-')) {
    throw new Error('--database <nom> requis : nom de la base à migrer (vérifié contre la connexion résolue)')
  }

  const url = env.DATABASE_URL || env.PGURL
  if (url) {
    let u
    try { u = new URL(url) } catch { throw new Error('DATABASE_URL / PGURL illisible') }
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const target = {
      source: env.DATABASE_URL ? 'DATABASE_URL' : 'PGURL',
      host: u.hostname || '(socket)', port: u.port || '5432', database,
      user: decodeURIComponent(u.username || ''),
    }
    if (database !== wanted) {
      throw new Error(
        `${target.source} pointe vers la base « ${database} » (${target.host}:${target.port}), pas « ${wanted} ». ` +
        `${target.source} est prioritaire sur POSTGRES_* : pour viser une autre base, la vider ` +
        '(docker compose run -e DATABASE_URL= -e PGURL= …)')
    }
    return { connection: { connectionString: url }, target }
  }

  if (env.POSTGRES_DB && env.POSTGRES_DB !== wanted) {
    throw new Error(`POSTGRES_DB vaut « ${env.POSTGRES_DB} », pas « ${wanted} » : incohérence, rien n'est fait`)
  }
  const target = {
    source: 'POSTGRES_*',
    host: env.POSTGRES_HOST || 'db', port: env.PGPORT || '5432', database: wanted,
    user: env.POSTGRES_USER || '',
  }
  return {
    connection: { host: target.host, database: wanted, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD },
    target,
  }
}

async function main() {
  let resolved
  try {
    resolved = resolveTarget(process.env, process.argv.slice(2))
  } catch (err) {
    console.error(`Cible refusée : ${err.message}`)
    process.exit(2)
  }
  const { connection, target } = resolved
  console.log(`Cible : ${target.host}:${target.port}/${target.database} (utilisateur ${target.user || '?'}, via ${target.source})`)

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
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main()
