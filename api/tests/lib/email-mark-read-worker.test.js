// Tests d'intégration du worker mark-read (Phase 5a, issue #8).
//
// Chemins critiques :
//   - Proposal acceptée → mail marqué via Graph + email_read_marked_at posé
//   - Proposal pending  → pas de marquage (on attend l'acceptation)
//   - Proposal rejected → pas de marquage (cas explicite "pas un ticket")
//   - message_appended  → marqué immédiatement (mail déjà visible côté Opale)
//   - Idempotence       : un mapping déjà marqué n'est pas re-traité
//   - send_enabled=false: skip global
//   - Échec Graph       : email_read_marked_at reste NULL (retry au prochain tick)

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { flushMarkRead } from '../../modules/email-bridge/lib/mark-read-worker.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip mark-read-worker suite'

let schema, db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  await db.query(`UPDATE settings SET value='true' WHERE key='mail.mark_as_read_enabled'`)
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

beforeEach(async () => {
  if (SKIP) return
  await db.query(`TRUNCATE TABLE email_thread_mapping, ticket_proposals, ticket_messages, tickets CASCADE`)
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedProposal(status = 'pending') {
  const { rows } = await db.query(`
    INSERT INTO ticket_proposals (source, suggested_title, status)
    VALUES ('email', 'P', $1) RETURNING id
  `, [status])
  return rows[0].id
}

async function seedTicket() {
  const { rows } = await db.query(`INSERT INTO tickets (title) VALUES ('T') RETURNING id`)
  return rows[0].id
}

async function seedMapping({ action, ticketId = null, proposalId = null, graphId = `g-${Math.random().toString(36).slice(2)}`, mailbox = 'box@example.com' } = {}) {
  const { rows } = await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, graph_message_id, mailbox, direction,
       action, ticket_id, proposal_id, processed_at)
    VALUES ($1, $2, $3, 'inbound', $4, $5, $6, now())
    RETURNING id
  `, [`<${Math.random().toString(36).slice(2)}@x>`, graphId, mailbox, action, ticketId, proposalId])
  return rows[0].id
}

function stubMark(captured, { throwOn = null } = {}) {
  return async (mailbox, graphId) => {
    if (throwOn && captured.length + 1 === throwOn) throw new Error('Graph 403')
    captured.push({ mailbox, graphId })
    return { ok: true }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('mark-read : proposal acceptée → mail marqué + timestamp posé', { skip: SKIP }, async () => {
  const pid = await seedProposal('accepted')
  const mid = await seedMapping({ action: 'proposal_created', proposalId: pid, graphId: 'g-acc-1' })

  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 1)
  assert.deepEqual(captured, [{ mailbox: 'box@example.com', graphId: 'g-acc-1' }])

  const { rows } = await db.query(`SELECT email_read_marked_at FROM email_thread_mapping WHERE id=$1`, [mid])
  assert.ok(rows[0].email_read_marked_at, 'timestamp doit être posé')
})

test('mark-read : proposal pending → pas de marquage', { skip: SKIP }, async () => {
  const pid = await seedProposal('pending')
  await seedMapping({ action: 'proposal_created', proposalId: pid })

  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 0)
  assert.equal(captured.length, 0)
})

test('mark-read : proposal rejected → pas de marquage', { skip: SKIP }, async () => {
  const pid = await seedProposal('rejected')
  await seedMapping({ action: 'proposal_created', proposalId: pid })

  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 0)
})

test('mark-read : message_appended → marqué immédiatement (sans proposal)', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedMapping({ action: 'message_appended', ticketId: tid, graphId: 'g-app-1' })

  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 1)
  assert.equal(captured[0].graphId, 'g-app-1')
})

test('mark-read : idempotence — mapping déjà marqué non re-traité', { skip: SKIP }, async () => {
  const pid = await seedProposal('accepted')
  const mid = await seedMapping({ action: 'proposal_created', proposalId: pid })
  // 1er passage : marque
  const cap1 = []
  await flushMarkRead(db, null, { markImpl: stubMark(cap1) })
  assert.equal(cap1.length, 1)
  // 2e passage : ne doit RIEN faire (timestamp déjà posé)
  const cap2 = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(cap2) })
  assert.equal(stats.marked, 0)
  assert.equal(cap2.length, 0)
})

test('mark-read : skipped_other (newsletter) → pas marqué (reste non-lu dans Outlook)', { skip: SKIP }, async () => {
  await seedMapping({ action: 'skipped_other' })
  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 0)
})

test('mark-read : enabled=false → skip global', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value='false' WHERE key='mail.mark_as_read_enabled'`)
  try {
    const tid = await seedTicket()
    await seedMapping({ action: 'message_appended', ticketId: tid })
    const captured = []
    const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
    assert.equal(stats.skipped, 'disabled')
    assert.equal(captured.length, 0)
  } finally {
    await db.query(`UPDATE settings SET value='true' WHERE key='mail.mark_as_read_enabled'`)
  }
})

test('mark-read : Graph échoue → email_read_marked_at reste NULL (retry au prochain tick)', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  const mid = await seedMapping({ action: 'message_appended', ticketId: tid })

  const failingMark = async () => { throw new Error('Graph 403 perm') }
  const stats = await flushMarkRead(db, null, { markImpl: failingMark })
  assert.equal(stats.errors, 1)
  assert.equal(stats.marked, 0)

  const { rows } = await db.query(`SELECT email_read_marked_at FROM email_thread_mapping WHERE id=$1`, [mid])
  assert.equal(rows[0].email_read_marked_at, null, 'doit rester NULL pour retry')
})

test('mark-read : graph_message_id NULL ignoré (pas d\'identifiant pour le PATCH)', { skip: SKIP }, async () => {
  // Edge case : un mapping sans graph_message_id (cas pathologique mais
  // possible si Graph a omis l'id à l'ingestion) ne doit pas crash le
  // worker, juste être skip.
  const tid = await seedTicket()
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, graph_message_id, mailbox, direction, action, ticket_id, processed_at)
    VALUES ($1, NULL, 'box@x', 'inbound', 'message_appended', $2, now())
  `, [`<no-graphid@x>`, tid])

  const captured = []
  const stats = await flushMarkRead(db, null, { markImpl: stubMark(captured) })
  assert.equal(stats.marked, 0)
  assert.equal(captured.length, 0)
})
