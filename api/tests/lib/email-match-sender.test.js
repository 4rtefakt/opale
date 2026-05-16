// Tests du matching expéditeur → user + device (Phase 2, issue #8).
//
// Edge cases couverts (cf. issue) :
//   - mail depuis adresse perso / domaine externe → pas de match
//   - alias / casse mixte → match insensible à la casse
//   - user sans device assigné → user trouvé, device null
//   - user avec plusieurs devices → on prend le plus récent (last_seen DESC)
//
// Schéma Postgres random par suite : on insère les fixtures à la main pour
// rester proche du contrat utilisateur (pas de helper fixture global).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { matchSender } from '../../modules/email-bridge/lib/match-sender.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip match-sender suite'

let schema, db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// ── Fixtures helper ──────────────────────────────────────────────────────────

async function seedUser(entraId, email, displayName) {
  await db.query(`
    INSERT INTO users_cache (entra_id, email, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (entra_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
  `, [entraId, email, displayName])
}

async function seedDevice(hostname, assignedUserEntraId, lastSeen = new Date()) {
  const { rows } = await db.query(`
    INSERT INTO devices (hostname, assigned_user_id, last_seen)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [hostname, assignedUserEntraId, lastSeen])
  return rows[0].id
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('matchSender : adresse vide / null → {}', { skip: SKIP }, async () => {
  assert.deepEqual(await matchSender(db, null),      {})
  assert.deepEqual(await matchSender(db, ''),        {})
  assert.deepEqual(await matchSender(db, '   '),     {})
  assert.deepEqual(await matchSender(db, undefined), {})
})

test('matchSender : email inconnu → {}', { skip: SKIP }, async () => {
  const out = await matchSender(db, 'inconnu@externe.com')
  assert.deepEqual(out, {})
})

test('matchSender : user connu sans device', { skip: SKIP }, async () => {
  await seedUser('entra-marie-1', 'marie@example.com', 'Marie Curie')
  const out = await matchSender(db, 'marie@example.com')
  assert.equal(out.user_id, 'entra-marie-1')
  assert.equal(out.user_email, 'marie@example.com')
  assert.equal(out.user_name, 'Marie Curie')
  assert.equal(out.device_id, null)
  assert.equal(out.device_hostname, null)
})

test('matchSender : casse mixte tolérée', { skip: SKIP }, async () => {
  await seedUser('entra-pierre-1', 'pierre@example.com', 'Pierre Skłodowska')
  const out = await matchSender(db, 'PIERRE@EXAMPLE.COM')
  assert.equal(out.user_id, 'entra-pierre-1')
})

test('matchSender : espaces autour de l\'email tolérés', { skip: SKIP }, async () => {
  await seedUser('entra-paul-1', 'paul@example.com', 'Paul')
  const out = await matchSender(db, '  Paul@example.com  ')
  assert.equal(out.user_id, 'entra-paul-1')
})

test('matchSender : user avec un device → device renvoyé', { skip: SKIP }, async () => {
  await seedUser('entra-jacques-1', 'jacques@example.com', 'Jacques')
  await seedDevice('PC-JACQUES', 'entra-jacques-1', new Date('2026-05-01'))
  const out = await matchSender(db, 'jacques@example.com')
  assert.equal(out.user_id, 'entra-jacques-1')
  assert.equal(out.device_hostname, 'PC-JACQUES')
})

test('matchSender : plusieurs devices → le plus récent gagne', { skip: SKIP }, async () => {
  await seedUser('entra-claude-1', 'claude@example.com', 'Claude')
  await seedDevice('PC-CLAUDE-OLD',    'entra-claude-1', new Date('2025-01-01'))
  await seedDevice('PC-CLAUDE-RECENT', 'entra-claude-1', new Date('2026-05-10'))
  await seedDevice('PC-CLAUDE-MID',    'entra-claude-1', new Date('2025-08-15'))
  const out = await matchSender(db, 'claude@example.com')
  assert.equal(out.device_hostname, 'PC-CLAUDE-RECENT')
})

test('matchSender : domaine externe (mail perso) → pas de match même si user existe', { skip: SKIP }, async () => {
  // Cas important de l'issue : un collègue écrit depuis son gmail perso.
  // On ne devine PAS le matching — il faut que le maintainer associe à la main.
  await seedUser('entra-emma-1', 'emma@example.com', 'Emma')
  const out = await matchSender(db, 'emma.perso@gmail.com')
  assert.deepEqual(out, {})
})

test('matchSender : email NULL en DB → pas de match (pas un crash)', { skip: SKIP }, async () => {
  // users_cache.email peut être NULL pour des comptes mal synchronisés.
  // matchSender('') doit retourner {} sans crash et sans matcher tous ces users.
  await db.query(`INSERT INTO users_cache (entra_id, email, display_name) VALUES ($1, NULL, $2)`,
    ['entra-noemail', 'No Email'])
  assert.deepEqual(await matchSender(db, ''), {})
})
