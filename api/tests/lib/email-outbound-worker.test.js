// Tests d'intégration du worker outbox (Phase 4, issue #8).
//
// Couvre les chemins critiques :
//   - Message éligible (ticket avec inbound mapping) → mail envoyé,
//     email_sent_at marqué
//   - Loop-protection : messages issus du pipeline inbound (email_sent_at
//     déjà posé) ne sont JAMAIS renvoyés
//   - Ticket sans origine mail (pas de mapping inbound) → pas d'envoi
//   - Type 'system' (changement de statut) → pas d'envoi
//   - Echec d'envoi → email_sent_at réinitialisé pour retry
//   - send_enabled='false' → skip global
//
// `sendImpl` est injecté en stub pour éviter tout appel HTTP réseau.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { flushOutbox } from '../../modules/email-bridge/lib/outbound-worker.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip outbound-worker suite'

let schema, db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  await db.query(`UPDATE settings SET value = 'true'              WHERE key = 'mail.send_enabled'`)
  await db.query(`UPDATE settings SET value = 'sender@example.com' WHERE key = 'mail.sender_address'`)
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// flushOutbox lit TOUS les pending — il faut isoler chaque test sur une
// table propre, sinon les fixtures précédentes contaminent les comptes.
beforeEach(async () => {
  if (SKIP) return
  await db.query(`TRUNCATE TABLE email_thread_mapping, ticket_messages, tickets CASCADE`)
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedTicket(title = 'T') {
  const { rows } = await db.query(`INSERT INTO tickets (title) VALUES ($1) RETURNING id`, [title])
  return rows[0].id
}

async function seedInboundMapping(ticketId, { mid = `<${Math.random().toString(36).slice(2)}@x>`, from = 'requester@example.com', subject = 'Imprimante' } = {}) {
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, from_address, subject, received_at, ticket_id)
    VALUES ($1, 'box@x', 'inbound', $2, $3, now(), $4)
  `, [mid, from, subject, ticketId])
  return mid
}

async function seedMessage(ticketId, { type = 'comment', content = 'Salut', emailSentAt = null, author = 'Helpdesk' } = {}) {
  const { rows } = await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [ticketId, type, author, content, emailSentAt])
  return rows[0].id
}

function stubSend(captured) {
  return async (args) => { captured.push(args); return { ok: true, status: 202 } }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('flushOutbox : message éligible → envoyé et marqué', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  const inboundMid = await seedInboundMapping(tid, { from: 'marie@example.com', subject: 'Imprimante bloque' })
  const msgId = await seedMessage(tid, { content: 'Bonjour Marie, je regarde.', author: 'Clément' })

  const captured = []
  const stats = await flushOutbox(db, null, { sendImpl: stubSend(captured) })
  assert.equal(stats.sent, 1)
  assert.equal(stats.errors, 0)

  assert.equal(captured.length, 1)
  assert.equal(captured[0].to, 'marie@example.com')
  assert.equal(captured[0].sender, 'sender@example.com')
  assert.match(captured[0].subject, /^\[Opale #[A-F0-9]{8}\] Imprimante bloque$/)
  assert.equal(captured[0].inReplyTo, inboundMid)
  assert.equal(captured[0].references, inboundMid)
  assert.match(captured[0].bodyText, /Bonjour Marie/)

  const { rows } = await db.query(`SELECT email_sent_at FROM ticket_messages WHERE id = $1`, [msgId])
  assert.ok(rows[0].email_sent_at, 'email_sent_at doit être posé après envoi')
})

test('flushOutbox : loop-protection — message inbound déjà marqué non renvoyé', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  // Message créé par le pipeline inbound : email_sent_at déjà posé.
  await seedMessage(tid, { content: 'Vient du mail entrant', emailSentAt: new Date() })

  const captured = []
  const stats = await flushOutbox(db, null, { sendImpl: stubSend(captured) })
  assert.equal(stats.sent, 0)
  assert.equal(captured.length, 0)
})

test('flushOutbox : ticket sans origine mail → pas d\'envoi', { skip: SKIP }, async () => {
  const tid = await seedTicket('Ticket purement interne')
  // Pas de seedInboundMapping ici : ticket créé à la main dans Opale.
  await seedMessage(tid, { content: 'Note interne' })

  const captured = []
  const stats = await flushOutbox(db, null, { sendImpl: stubSend(captured) })
  assert.equal(stats.sent, 0)
  assert.equal(captured.length, 0)
})

test('flushOutbox : type system ignoré', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  await seedMessage(tid, { type: 'system', content: 'Ticket pris en charge' })

  const captured = []
  const stats = await flushOutbox(db, null, { sendImpl: stubSend(captured) })
  assert.equal(stats.sent, 0)
})

test('flushOutbox : échec d\'envoi → email_sent_at réinitialisé pour retry', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  const msgId = await seedMessage(tid, { content: 'À renvoyer' })

  const flakyStub = async () => { throw new Error('Graph 500') }
  const stats = await flushOutbox(db, null, { sendImpl: flakyStub })
  assert.equal(stats.errors, 1)
  assert.equal(stats.sent, 0)

  const { rows } = await db.query(`SELECT email_sent_at FROM ticket_messages WHERE id = $1`, [msgId])
  assert.equal(rows[0].email_sent_at, null, 'email_sent_at doit être annulé pour permettre retry')
})

test('flushOutbox : send_enabled=false → skip global', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value = 'false' WHERE key = 'mail.send_enabled'`)
  try {
    const tid = await seedTicket()
    await seedInboundMapping(tid)
    await seedMessage(tid, { content: 'Devrait pas partir' })

    const captured = []
    const stats = await flushOutbox(db, null, { sendImpl: stubSend(captured) })
    assert.equal(stats.skipped, 'disabled')
    assert.equal(captured.length, 0)
  } finally {
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'mail.send_enabled'`)
  }
})

test('flushOutbox : sender vide → skip avec raison', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value = '' WHERE key = 'mail.sender_address'`)
  try {
    const stats = await flushOutbox(db, null, { sendImpl: async () => ({}) })
    assert.equal(stats.skipped, 'no-sender-configured')
  } finally {
    await db.query(`UPDATE settings SET value = 'sender@example.com' WHERE key = 'mail.sender_address'`)
  }
})

test('flushOutbox : multi-inbound → destinataire = dernier expéditeur', { skip: SKIP }, async () => {
  // Cas escalade : Marie écrit, puis Paul rejoint le thread. La réponse
  // doit aller à Paul (dernier expéditeur), pas à Marie.
  const tid = await seedTicket()
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, from_address, received_at, ticket_id)
    VALUES
      ('<m1@x>', 'box@x', 'inbound', 'marie@example.com', '2026-05-01', $1),
      ('<m2@x>', 'box@x', 'inbound', 'paul@example.com',  '2026-05-10', $1)
  `, [tid])
  await seedMessage(tid, { content: 'Réponse au dernier' })

  const captured = []
  await flushOutbox(db, null, { sendImpl: stubSend(captured) })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].to, 'paul@example.com')
  // References doit lister les deux dans l'ordre chronologique.
  assert.equal(captured[0].references, '<m1@x> <m2@x>')
  assert.equal(captured[0].inReplyTo, '<m2@x>')
})
