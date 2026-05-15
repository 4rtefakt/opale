// routes/groups.js : endpoints Entra-side (autocomplete + sync manuel).
//
// ⚠ Ne pas confondre avec routes/native-groups.js (déjà testé).
//
// Endpoints :
//   GET  /api/groups/search?q=...  — appelle searchAADGroups(Graph)
//   POST /api/groups/sync          — appelle syncGroupMemberships(Graph)
//
// Stratégie : mocker lib/graph.js + lib/group-sync.js au niveau module n'est
// pas faisable proprement en node:test ESM sans register-hooks. On couvre :
//   - Auth : 401 sans token sur les deux endpoints
//   - ACL  : 403 non-admin sur POST /sync
// Note : les chemins métier (résultats Graph, résultats sync) sont skippés —
//        "Graph mocking not feasible in node:test ESM".

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import groupsRoute from '../../modules/groups/routes/groups.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt

before(async () => {
  if (!isDbAvailable()) return

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(groupsRoute, { prefix: '/api/groups' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

// ─── Auth 401 ─────────────────────────────────────────────────────────────────

test('GET /search — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/groups/search?q=test' })
  assert.equal(res.statusCode, 401)
})

test('POST /sync — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'POST', url: '/api/groups/sync' })
  assert.equal(res.statusCode, 401)
})

// ─── ACL admin ────────────────────────────────────────────────────────────────

test('POST /sync — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-grp-entra-nonadmin', email: 'nonadmin-grp@x' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const res = await fastify.inject({
    method: 'POST', url: '/api/groups/sync',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

// NOTE : les chemins métier de GET /search et POST /sync (appels Graph réels,
// résultats syncGroupMemberships) ne sont pas testés ici.
// Raison : mocker lib/graph.js et lib/group-sync.js nécessite des register
// hooks ESM (--loader ou --experimental-vm-modules) non disponibles dans
// node:test sans configuration additionnelle.
// Couverture actuelle : auth + ACL (3 tests).
