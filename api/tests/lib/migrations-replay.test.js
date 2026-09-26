// Rejeu des migrations sur une base PEUPLÉE.
//
// La CI (validate-sql-migrations) rejoue les migrations deux fois, mais sur
// une base vide. Le runner de démarrage rejoue tout fichier absent de
// schema_migrations : sur la prod migrée à la main, chaque fichier repasse
// donc sur des données réelles. Ces tests fixent les cas où un rejeu
// échouait (API bloquée au démarrage) ou modifiait silencieusement des
// données. Chaque fichier est joué comme psql / la CI le font : le fichier
// entier en une requête.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedReplayHazards, assertReplayHazardsIntact } from '../helpers/populated-db.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

after(closeSharedPool)

async function replay(db, file) {
  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
  await db.query(sql)
}

async function allFiles() {
  return (await fs.readdir(MIGRATIONS_DIR)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()
}

async function withSchema(t) {
  const acquired = await acquireSchema()
  t.after(acquired.release)
  return acquired.db
}

test('010 rejouée : un poste agent rattaché par la sync Intune reste source=agent', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  const seed = await seedReplayHazards(db)
  await replay(db, '010_agent_source.sql')
  const { rows } = await db.query(`SELECT source FROM devices WHERE id = $1`, [seed.agentDev.id])
  // Sinon le poste sort des alertes « offline » (alerts.js filtre source='agent').
  assert.equal(rows[0].source, 'agent')
})

test('043 rejouée après 052 avec un job native_group : pas d’erreur, contraintes de 052 conservées', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  const seed = await seedReplayHazards(db)
  await replay(db, '043_deployment_jobs_user_scope.sql')
  // La contrainte de 052 (sur-ensemble) est toujours en place : un nouveau
  // job native_group est accepté.
  await db.query(`
    INSERT INTO deployment_jobs (package_id, scope, native_group_id) VALUES ($1, 'native_group', $2)
  `, [seed.pkg.id, seed.group.id])
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM deployment_jobs WHERE scope = 'native_group'`)
  assert.equal(rows[0].n, 2)
})

test('060 rejouée : ni relations recréées sur un ticket fusionné, ni erreur sur un requester divergent', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  const seed = await seedReplayHazards(db)
  await replay(db, '060_tickets_multi_relations.sql')
  await assertReplayHazardsIntact(db, assert, seed)
})

test('060 sur une base sans relations : le backfill initial a toujours lieu', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  await db.query(`INSERT INTO users_cache (entra_id) VALUES ('bf-u1')`)
  const { rows: [dev] } = await db.query(`INSERT INTO devices (hostname) VALUES ('PC-BF') RETURNING id`)
  const { rows: [tk] } = await db.query(
    `INSERT INTO tickets (title, user_id, device_id) VALUES ('Backfill', 'bf-u1', $1) RETURNING id`, [dev.id]
  )
  // État « avant 060 » : tickets remplis, tables de relations vides.
  await replay(db, '060_tickets_multi_relations.sql')
  const { rows: users } = await db.query(`SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1`, [tk.id])
  assert.deepEqual(users, [{ user_entra_id: 'bf-u1', role: 'requester' }])
  const { rows: devs } = await db.query(`SELECT device_id FROM ticket_devices WHERE ticket_id = $1`, [tk.id])
  assert.deepEqual(devs, [{ device_id: dev.id }])
})

test('046 dans le schéma courant : ssh_sessions archivée, puis supprimée si 003 la recrée au rejeu', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  // Les suites tournent dans un schéma t_xxx : 046 doit y trouver ses
  // tables (elle cherchait en dur dans « public », et ne s'appliquait donc
  // pas hors de public — le chemin prod n'était jamais exercé en test).
  const reg = async (name) => (await db.query(`SELECT to_regclass($1) AS r`, [name])).rows[0].r
  assert.equal(await reg('ssh_sessions_archive_pre046'), 'ssh_sessions_archive_pre046')
  assert.equal(await reg('ssh_sessions'), null)

  await replay(db, '003_scripts_ssh.sql')   // recrée ssh_sessions (vide)
  assert.equal(await reg('ssh_sessions'), 'ssh_sessions')
  await replay(db, '046_remote_sessions.sql')
  assert.equal(await reg('ssh_sessions'), null)
  assert.equal(await reg('ssh_sessions_archive_pre046'), 'ssh_sessions_archive_pre046')
})

test('toutes les migrations rejouées deux fois sur une base peuplée : aucune erreur, données intactes', { skip: SKIP }, async (t) => {
  const db = await withSchema(t)
  const seed = await seedReplayHazards(db)
  for (let pass = 1; pass <= 2; pass++) {
    for (const f of await allFiles()) {
      try {
        await replay(db, f)
      } catch (err) {
        assert.fail(`passe ${pass}, ${f} : ${err.message}`)
      }
    }
  }
  await assertReplayHazardsIntact(db, assert, seed)
})
