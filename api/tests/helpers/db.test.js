// Smoke test du helper db — valide que acquireSchema() applique bien toutes
// les migrations et que le pool retourné voit le schéma de la suite. Si ce
// test passe, les helpers DB sont opérationnels et les futures suites
// d'intégration (routes, plugin auth, evaluateAndPersist, etc.) peuvent
// s'appuyer dessus sans surprise.
//
// Skip silencieux si PG_TEST_URL est absent — utile en dev sans PG local.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from './db.js'

test('acquireSchema applique les migrations et isole le search_path', async (t) => {
  if (!isDbAvailable()) {
    t.skip('PG_TEST_URL non défini — skip (les suites pures continuent)')
    return
  }
  const { schema, db, release } = await acquireSchema()
  t.after(release)
  t.after(closeSharedPool)

  // Sanity check : le schéma actif est bien celui de la suite, pas public.
  const { rows: schemaRows } = await db.query('SHOW search_path')
  assert.match(schemaRows[0].search_path, new RegExp(schema), 'search_path doit pointer sur le schéma')

  // Sanity check : la table users_cache (créée en 001_init.sql) existe et
  // est vide. Si une migration de la chaîne 0..NNN a planté, ce SELECT
  // remonte une erreur 42P01 (relation does not exist).
  const { rows: userRows } = await db.query('SELECT count(*)::int AS n FROM users_cache')
  assert.equal(userRows[0].n, 0)

  // Sanity check : la dernière migration de la suite est appliquée. cli_tokens
  // a été créée en 050 — si on rate la chaîne, ce SELECT pète.
  const { rows: cliRows } = await db.query('SELECT count(*)::int AS n FROM cli_tokens')
  assert.equal(cliRows[0].n, 0)
})
