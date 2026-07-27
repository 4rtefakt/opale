import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { maybeBootstrapAdmin, warnIfNoAdmin } from '../../modules/core/lib/bootstrap-admin.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'

const dbAvailable = isDbAvailable()
const silent = { info() {}, warn() {}, error() {} }

let ctx = null
before(async () => { if (dbAvailable) ctx = await acquireSchema() })
after(async () => { if (ctx) await ctx.release(); await closeSharedPool() })

const skip = !dbAvailable && 'PG_TEST_URL non défini'

async function addUser(db, { entraId, email, isAdmin = false }) {
  await db.query(
    `INSERT INTO users_cache (entra_id, display_name, email, is_admin)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entra_id) DO UPDATE SET is_admin = EXCLUDED.is_admin`,
    [entraId, email, email, isAdmin]
  )
}

async function reset(db) {
  await db.query('DELETE FROM audit_logs')
  await db.query('DELETE FROM users_cache')
}

test('promeut le premier utilisateur quand aucun admin n\'existe', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'u1', email: 'alice@x.org' })

  const promoted = await maybeBootstrapAdmin(
    ctx.db, silent, { entraId: 'u1', email: 'alice@x.org', displayName: 'Alice' }, {}
  )
  assert.equal(promoted, true)

  const { rows } = await ctx.db.query('SELECT is_admin FROM users_cache WHERE entra_id = $1', ['u1'])
  assert.equal(rows[0].is_admin, true)
})

test('trace la promotion dans le journal d\'audit', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'u1', email: 'alice@x.org' })
  await maybeBootstrapAdmin(ctx.db, silent, { entraId: 'u1', email: 'alice@x.org', displayName: 'Alice' }, {})

  const { rows } = await ctx.db.query(`SELECT action, details FROM audit_logs WHERE action = 'admin_bootstrapped'`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].details.mode, 'first-login')
})

test('ne promeut personne si un admin existe déjà', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'boss', email: 'boss@x.org', isAdmin: true })
  await addUser(ctx.db, { entraId: 'u2',   email: 'bob@x.org' })

  const promoted = await maybeBootstrapAdmin(
    ctx.db, silent, { entraId: 'u2', email: 'bob@x.org', displayName: 'Bob' }, {}
  )
  assert.equal(promoted, false)

  const { rows } = await ctx.db.query('SELECT is_admin FROM users_cache WHERE entra_id = $1', ['u2'])
  assert.equal(rows[0].is_admin, false)
})

test('OPALE_BOOTSTRAP_ADMIN_UPN : seul le compte nommé est promu', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'u1', email: 'alice@x.org' })
  await addUser(ctx.db, { entraId: 'u2', email: 'bob@x.org' })
  const env = { OPALE_BOOTSTRAP_ADMIN_UPN: 'bob@x.org' }

  assert.equal(
    await maybeBootstrapAdmin(ctx.db, silent, { entraId: 'u1', email: 'alice@x.org' }, env),
    false,
    'un compte non nommé ne doit pas être promu'
  )
  assert.equal(
    await maybeBootstrapAdmin(ctx.db, silent, { entraId: 'u2', email: 'bob@x.org' }, env),
    true
  )
})

test('OPALE_BOOTSTRAP_ADMIN_UPN : comparaison insensible à la casse et aux espaces', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'u1', email: 'Alice@X.org' })

  const promoted = await maybeBootstrapAdmin(
    ctx.db, silent, { entraId: 'u1', email: 'Alice@X.org' },
    { OPALE_BOOTSTRAP_ADMIN_UPN: '  alice@x.ORG ' }
  )
  assert.equal(promoted, true)
})

test('deux connexions simultanées ne produisent qu\'un seul admin', { skip }, async () => {
  await reset(ctx.db)
  await addUser(ctx.db, { entraId: 'u1', email: 'alice@x.org' })
  await addUser(ctx.db, { entraId: 'u2', email: 'bob@x.org' })

  const results = await Promise.all([
    maybeBootstrapAdmin(ctx.db, silent, { entraId: 'u1', email: 'alice@x.org' }, {}),
    maybeBootstrapAdmin(ctx.db, silent, { entraId: 'u2', email: 'bob@x.org' }, {}),
  ])
  assert.equal(results.filter(Boolean).length, 1, 'une seule promotion attendue')

  const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM users_cache WHERE is_admin')
  assert.equal(rows[0].n, 1)
})

test('identité sans entraId : no-op', { skip }, async () => {
  await reset(ctx.db)
  assert.equal(await maybeBootstrapAdmin(ctx.db, silent, {}, {}), false)
  assert.equal(await maybeBootstrapAdmin(ctx.db, silent, null, {}), false)
})

test('warnIfNoAdmin : true tant qu\'aucun admin, false ensuite', { skip }, async () => {
  await reset(ctx.db)
  assert.equal(await warnIfNoAdmin(ctx.db, silent, {}), true)

  await addUser(ctx.db, { entraId: 'boss', email: 'boss@x.org', isAdmin: true })
  assert.equal(await warnIfNoAdmin(ctx.db, silent, {}), false)
})
