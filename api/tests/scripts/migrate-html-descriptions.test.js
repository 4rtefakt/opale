// Couvre api/scripts/migrate-html-descriptions-to-messages.js :
// - happy path : ticket HTML + email_thread_mapping → message créé, desc raccourcie
// - fallback users_cache quand pas de mapping
// - idempotence : re-run ne double pas les messages
// - ticket sans HTML : laissé intact
// - mode --check (dryRun) : aucune modification en DB

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { runMigration } from '../../scripts/migrate-html-descriptions-to-messages.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release
// Logger silencieux pour ne pas polluer la sortie des tests.
const quietLog = { log: () => {}, error: () => {} }

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function insertTicket(db, { description, userId = null, title = 'Ticket test' }) {
  const { rows } = await db.query(`
    INSERT INTO tickets (title, description, priority, user_id, source, is_auto, created_by_entra_id)
    VALUES ($1, $2, 'normal', $3, 'manual', false, 'tester')
    RETURNING *
  `, [title, description, userId])
  return rows[0]
}

async function insertInboundMapping(db, { ticketId, fromAddress, fromName, receivedAt }) {
  // raw : JSON Graph minimal réaliste
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, from_address, subject, received_at, raw,
       ticket_id, action, processed_at)
    VALUES ($1, 'support@test', 'inbound', $2, 'Sujet test', $3, $4, $5, 'message_appended', now())
  `, [
    `<msg-${Math.random().toString(36).slice(2)}@test>`,
    fromAddress,
    receivedAt,
    JSON.stringify({ from: { emailAddress: { address: fromAddress, name: fromName } } }),
    ticketId,
  ])
}

async function insertUser(db, { entraId, displayName }) {
  await db.query(`
    INSERT INTO users_cache (entra_id, display_name, email)
    VALUES ($1, $2, $3)
    ON CONFLICT (entra_id) DO NOTHING
  `, [entraId, displayName, `${entraId}@x`])
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('runMigration : ticket HTML + mapping → message créé, desc raccourcie', { skip: SKIP }, async () => {
  const tk = await insertTicket(db, {
    description: '<html><body><p>Bonjour,</p><p>L\'imprimante est en panne.</p></body></html>',
  })
  await insertInboundMapping(db, {
    ticketId: tk.id,
    fromAddress: 'alice@ex.fr',
    fromName: 'Alice Dupont',
    receivedAt: '2026-02-05T14:30:00.000Z',
  })

  const res = await runMigration(db, { log: quietLog })
  assert.equal(res.migrated, 1)

  const { rows: [updated] } = await db.query(`SELECT description FROM tickets WHERE id = $1`, [tk.id])
  assert.match(updated.description, /^Mail de Alice Dupont reçu le /)
  assert.ok(!updated.description.includes('imprimante'), 'body NE doit PAS rester dans desc')

  const { rows: msgs } = await db.query(
    `SELECT type, author, content FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].type, 'comment')
  assert.equal(msgs[0].author, 'Alice Dupont')
  assert.match(msgs[0].content, /imprimante est en panne/)
})

test('runMigration : pas de mapping → fallback users_cache via tickets.user_id', { skip: SKIP }, async () => {
  await insertUser(db, { entraId: 'oid-bob-fallback', displayName: 'Bob Martin' })
  const tk = await insertTicket(db, {
    description: '<div>Mon poste est lent.</div>',
    userId: 'oid-bob-fallback',
  })

  const res = await runMigration(db, { log: quietLog })
  assert.ok(res.migrated >= 1)

  const { rows: msgs } = await db.query(
    `SELECT author, content FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].author, 'Bob Martin')
  assert.match(msgs[0].content, /poste est lent/)
})

test('runMigration : idempotence — 2e run ne crée pas de doublon', { skip: SKIP }, async () => {
  const tk = await insertTicket(db, {
    description: '<p>Demande accès partage RH.</p>',
  })
  await insertInboundMapping(db, {
    ticketId: tk.id, fromAddress: 'carole@ex.fr', fromName: 'Carole', receivedAt: '2026-02-04T10:00:00Z',
  })

  await runMigration(db, { log: quietLog })
  await runMigration(db, { log: quietLog }) // 2e passe

  const { rows: msgs } = await db.query(
    `SELECT id FROM ticket_messages WHERE ticket_id = $1`, [tk.id]
  )
  assert.equal(msgs.length, 1, 'pas de doublon après 2e run')
})

test('runMigration : ticket sans HTML laissé intact', { skip: SKIP }, async () => {
  const tk = await insertTicket(db, {
    description: 'Ceci est une description en texte propre, pas de balise.',
  })

  const before = await db.query(`SELECT description FROM tickets WHERE id = $1`, [tk.id])
  await runMigration(db, { log: quietLog })
  const after = await db.query(`SELECT description FROM tickets WHERE id = $1`, [tk.id])
  assert.equal(after.rows[0].description, before.rows[0].description)

  const { rows: msgs } = await db.query(`SELECT id FROM ticket_messages WHERE ticket_id = $1`, [tk.id])
  assert.equal(msgs.length, 0)
})

test('runMigration : dryRun ne modifie rien', { skip: SKIP }, async () => {
  const tk = await insertTicket(db, {
    description: '<p>Dry-run check</p>',
  })

  const res = await runMigration(db, { dryRun: true, log: quietLog })
  assert.ok(res.migrated >= 1)

  const { rows: msgs } = await db.query(`SELECT id FROM ticket_messages WHERE ticket_id = $1`, [tk.id])
  assert.equal(msgs.length, 0, 'dryRun ne doit pas INSERT')

  const { rows: [t] } = await db.query(`SELECT description FROM tickets WHERE id = $1`, [tk.id])
  assert.match(t.description, /^<p>/, 'description originale inchangée')
})
