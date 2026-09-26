// scripts/migrate-instance/tables.js doit couvrir TOUT le schéma.
//
// Le catalogue était maintenu à la main et avait décroché (groupes,
// relations de tickets, pont mail, tokens CLI… absents : non copiés lors
// d'une bascule d'instance, sans aucun avertissement). Ce test applique
// les migrations dans un schéma scratch et vérifie :
//   - chaque table du schéma est soit copiée (TABLES), soit exclue
//     explicitement (EXCLUDED_TABLES, avec une raison) ;
//   - aucune entrée ne désigne une table disparue ;
//   - l'ordre respecte les clés étrangères (parent avant enfant), les
//     auto-références étant déclarées en selfRefColumn ;
//   - chaque conflictTarget correspond à une contrainte d'unicité réelle
//     (sinon INSERT … ON CONFLICT échoue).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import * as catalog from '../../../scripts/migrate-instance/tables.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const TABLES = catalog.TABLES
const EXCLUDED = catalog.EXCLUDED_TABLES ?? []

let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

async function schemaTables() {
  const { rows } = await db.query(`
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
    ORDER BY 1
  `)
  return rows.map(r => r.name)
}

test('chaque table du schéma est copiée ou exclue explicitement', { skip: SKIP }, async () => {
  const declared = new Set([...TABLES.map(t => t.name), ...EXCLUDED.map(t => t.name)])
  const missing = (await schemaTables()).filter(n => !declared.has(n))
  assert.deepEqual(missing, [],
    `tables absentes de scripts/migrate-instance/tables.js : ${missing.join(', ')}`)
})

test('aucune entrée obsolète, aucun doublon, chaque exclusion justifiée', { skip: SKIP }, async () => {
  const existing = new Set(await schemaTables())
  const names = [...TABLES.map(t => t.name), ...EXCLUDED.map(t => t.name)]
  assert.deepEqual(names.filter(n => !existing.has(n)), [], 'tables inconnues du schéma')
  assert.equal(new Set(names).size, names.length, 'table déclarée deux fois')
  for (const e of EXCLUDED) assert.ok(e.reason && e.reason.length > 10, `raison d'exclusion manquante : ${e.name}`)
})

test('ordre : parent avant enfant pour chaque clé étrangère, auto-références en selfRefColumn', { skip: SKIP }, async () => {
  const { rows: fks } = await db.query(`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           array_agg(a.attname::text ORDER BY a.attnum) AS cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
    GROUP BY c.oid, c.conrelid, c.confrelid
  `)
  const pos = new Map(TABLES.map((t, i) => [t.name, i]))
  const problems = []
  for (const fk of fks) {
    if (!pos.has(fk.child) || !pos.has(fk.parent)) continue
    const cfg = TABLES[pos.get(fk.child)]
    if (fk.child === fk.parent) {
      if (cfg.selfRefColumn !== fk.cols[0]) problems.push(`${fk.child}.${fk.cols[0]} : auto-référence sans selfRefColumn`)
    } else if (pos.get(fk.parent) > pos.get(fk.child)) {
      problems.push(`${fk.child} (FK ${fk.cols.join(',')}) copié avant son parent ${fk.parent}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('conflictTarget = contrainte d’unicité réelle (ON CONFLICT utilisable)', { skip: SKIP }, async () => {
  const { rows } = await db.query(`
    SELECT t.relname AS tbl, array_agg(a.attname::text ORDER BY a.attname::text) AS cols
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = current_schema() AND i.indisunique AND i.indpred IS NULL
    GROUP BY i.indexrelid, t.relname
  `)
  const uniques = new Map()
  for (const r of rows) {
    if (!uniques.has(r.tbl)) uniques.set(r.tbl, [])
    uniques.get(r.tbl).push(r.cols.join(','))
  }
  const bad = TABLES
    .filter(t => !(uniques.get(t.name) || []).includes([...t.conflictTarget].sort().join(',')))
    .map(t => `${t.name} (${t.conflictTarget.join(',')})`)
  assert.deepEqual(bad, [])
})
