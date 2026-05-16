// Tests du matching mail entrant → ticket existant (Phase 2, issue #8).
//
// Ce que ça doit faire correctement (sans ça, threading cassé) :
//   - prioriser In-Reply-To sur References (parent direct > chaîne)
//   - utiliser le conversationId Graph en fallback (mail dont les headers
//     RFC manquent — Outlook web parfois)
//   - retourner ticket_id en priorité sur proposal_id (acceptation > attente)
//   - ne PAS matcher si tous les indices pointent vers des mails sans
//     ticket_id NI proposal_id (les mappings Phase 1 "log-only")

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { matchThread } from '../../modules/email-bridge/lib/match-thread.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip match-thread suite'

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function seedTicket(title = 'T') {
  const { rows } = await db.query(
    `INSERT INTO tickets (title) VALUES ($1) RETURNING id`, [title]
  )
  return rows[0].id
}

async function seedProposal() {
  const { rows } = await db.query(
    `INSERT INTO ticket_proposals (source, suggested_title) VALUES ('email', 'P') RETURNING id`
  )
  return rows[0].id
}

async function seedMapping({
  internetMessageId, conversationId = null, ticketId = null, proposalId = null,
  receivedAt = new Date(),
}) {
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, conversation_id, mailbox, direction, received_at,
       ticket_id, proposal_id)
    VALUES ($1, $2, 'box@test', 'inbound', $3, $4, $5)
  `, [internetMessageId, conversationId, receivedAt, ticketId, proposalId])
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('matchThread : aucun indice → null', { skip: SKIP }, async () => {
  assert.equal(await matchThread(db, {}), null)
  assert.equal(await matchThread(db, { inReplyToHeader: null, referencesHeader: null }), null)
})

test('matchThread : In-Reply-To → ticket', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedMapping({ internetMessageId: '<parent-1@x>', ticketId: tid })
  const out = await matchThread(db, { inReplyToHeader: '<parent-1@x>' })
  assert.equal(out.ticket_id, tid)
  assert.equal(out.via, 'message-id')
})

test('matchThread : In-Reply-To prioritaire sur References', { skip: SKIP }, async () => {
  const tidA = await seedTicket('A')
  const tidB = await seedTicket('B')
  await seedMapping({ internetMessageId: '<inreply@x>', ticketId: tidA })
  await seedMapping({ internetMessageId: '<refonly@x>', ticketId: tidB })
  // In-Reply-To pointe vers le ticket A, References vers le ticket B.
  // On doit prendre A (parent direct).
  const out = await matchThread(db, {
    inReplyToHeader:  '<inreply@x>',
    referencesHeader: '<refonly@x> <inreply@x>',
  })
  assert.equal(out.ticket_id, tidA)
})

test('matchThread : References parcouru si In-Reply-To absent', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedMapping({ internetMessageId: '<mid-thread@x>', ticketId: tid })
  const out = await matchThread(db, {
    referencesHeader: '<root@x> <mid-thread@x> <last@x>',
  })
  assert.equal(out.ticket_id, tid)
})

test('matchThread : conversationId en fallback', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedMapping({
    internetMessageId: '<unrelated@x>',
    conversationId: 'CONV-ABC-123',
    ticketId: tid,
  })
  const out = await matchThread(db, { conversationId: 'CONV-ABC-123' })
  assert.equal(out.ticket_id, tid)
  assert.equal(out.via, 'conversation-id')
})

test('matchThread : conversationId → mail le plus récent du thread gagne', { skip: SKIP }, async () => {
  const tidA = await seedTicket('A')
  const tidB = await seedTicket('B')
  // Deux mappings sur la même conversation, pointant vers des tickets
  // différents (cas pathologique mais possible si un thread a été fusionné).
  // On prend le plus récent.
  await seedMapping({
    internetMessageId: '<old@x>', conversationId: 'CONV-MULTI',
    ticketId: tidA, receivedAt: new Date('2025-01-01'),
  })
  await seedMapping({
    internetMessageId: '<new@x>', conversationId: 'CONV-MULTI',
    ticketId: tidB, receivedAt: new Date('2026-05-01'),
  })
  const out = await matchThread(db, { conversationId: 'CONV-MULTI' })
  assert.equal(out.ticket_id, tidB)
})

test('matchThread : mappings sans ticket_id NI proposal_id ignorés', { skip: SKIP }, async () => {
  // Les mappings Phase 1 (log-only) n'ont pas de ticket — on ne doit pas
  // les matcher, sinon on créerait des messages orphelins.
  await seedMapping({ internetMessageId: '<orphan@x>' })
  const out = await matchThread(db, { inReplyToHeader: '<orphan@x>' })
  assert.equal(out, null)
})

test('matchThread : proposal_id retourné si pas de ticket', { skip: SKIP }, async () => {
  const pid = await seedProposal()
  await seedMapping({ internetMessageId: '<proposal-thread@x>', proposalId: pid })
  const out = await matchThread(db, { inReplyToHeader: '<proposal-thread@x>' })
  assert.equal(out.proposal_id, pid)
  assert.equal(out.ticket_id, null)
})
