// Helpers DB pour les tests d'intégration API.
//
// Stratégie : un PG réel (16 en prod, 16 en CI via `services:`). Chaque suite
// qui en a besoin acquiert son propre schéma Postgres random (`t_<6hex>`) avec
// toutes les migrations 0*.sql rejouées dedans, puis le drop en cleanup.
// L'isolation par schéma plutôt que par database évite le coût de
// CREATE/DROP DATABASE (qui exige une connexion détachée).
//
// Le pool retourné par acquireSchema() est configuré avec
// `options: '-c search_path=<schema>'` côté libpq — toutes les requêtes
// passées à ce pool s'exécutent dans le schéma de la suite sans préfixe
// explicite, identique à un PG vierge.
//
// Si `PG_TEST_URL` est absent, isDbAvailable() retourne false et les suites
// concernées doivent `t.skip()` plutôt que crasher (utile en dev quand le
// PG local n'est pas démarré, on garde les suites pures qui tournent).

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

let sharedPool = null

export function isDbAvailable() {
  return !!process.env.PG_TEST_URL
}

function getSharedPool() {
  if (!sharedPool) {
    if (!process.env.PG_TEST_URL) {
      throw new Error(
        'PG_TEST_URL non défini. Pour lancer les tests qui touchent à la DB :\n' +
        '  1. Démarrer un Postgres 16 (docker compose, container dédié, ou local)\n' +
        '  2. export PG_TEST_URL=postgres://user:pwd@localhost:5432/dbname'
      )
    }
    sharedPool = new pg.Pool({ connectionString: process.env.PG_TEST_URL, max: 4 })
  }
  return sharedPool
}

// Acquiert un schéma random + applique toutes les migrations 0*.sql.
// Retourne { schema, db, release } — db est un pg.Pool dont les requêtes
// s'exécutent dans le schéma sans préfixe. release() drop le schéma.
export async function acquireSchema() {
  const shared = getSharedPool()
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`
  await shared.query(`CREATE SCHEMA "${schema}"`)

  const db = new pg.Pool({
    connectionString: process.env.PG_TEST_URL,
    max: 4,
    options: `-c search_path="${schema}"`,
  })

  try {
    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter(f => /^\d+_.*\.sql$/.test(f))
      .sort()
    for (const f of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8')
      await db.query(sql)
    }
  } catch (err) {
    await db.end().catch(() => {})
    await shared.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
    throw err
  }

  return {
    schema,
    db,
    release: async () => {
      await db.end().catch(() => {})
      await shared.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {})
    },
  }
}

// À appeler en cleanup global (process exit). node:test ne fournit pas de
// hook "after-all-suites" — chaque suite est responsable de release(), et
// le pool partagé reste ouvert jusqu'à la fin du process.
export async function closeSharedPool() {
  if (sharedPool) {
    await sharedPool.end().catch(() => {})
    sharedPool = null
  }
}
