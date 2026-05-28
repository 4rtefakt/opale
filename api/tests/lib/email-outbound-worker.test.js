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

// Par défaut on seede un graph_message_id → le worker prend le chemin
// "réponse threadée" (createReply). Passer graphId=null pour forcer le
// fallback sendMail (vieux mapping sans id Graph).
async function seedInboundMapping(ticketId, {
  mid = `<${Math.random().toString(36).slice(2)}@x>`,
  from = 'requester@example.com', subject = 'Imprimante',
  graphId = `graph-${Math.random().toString(36).slice(2)}`,
} = {}) {
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, graph_message_id, mailbox, direction, from_address, subject, received_at, ticket_id)
    VALUES ($1, $2, 'box@x', 'inbound', $3, $4, now(), $5)
  `, [mid, graphId, from, subject, ticketId])
  return { mid, graphId }
}

async function seedMessage(ticketId, { type = 'comment', content = 'Salut', emailSentAt = null, author = 'Helpdesk' } = {}) {
  const { rows } = await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [ticketId, type, author, content, emailSentAt])
  return rows[0].id
}

function stubSend(captured)  { return async (args) => { captured.push(args); return { ok: true, status: 202 } } }
function stubReply(captured) { return async (args) => { captured.push(args); return { ok: true } } }

// Stubs combinés : un seul des deux est appelé selon le chemin.
function stubs() {
  const sent = [], replied = []
  return {
    sent, replied,
    opts: { sendImpl: stubSend(sent), sendReplyImpl: stubReply(replied) },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('flushOutbox : message éligible (graph_message_id) → réponse threadée (createReply)', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  const { graphId } = await seedInboundMapping(tid, { from: 'marie@example.com', subject: 'Imprimante bloque' })
  const msgId = await seedMessage(tid, { content: 'Bonjour Marie, je regarde.', author: 'Clément' })

  const s = stubs()
  const stats = await flushOutbox(db, null, s.opts)
  assert.equal(stats.sent, 1)
  assert.equal(stats.errors, 0)

  // Chemin createReply : sendReplyImpl appelé avec mailbox + graphMessageId.
  assert.equal(s.replied.length, 1)
  assert.equal(s.sent.length, 0, 'pas de sendMail quand on a un graph_message_id')
  assert.equal(s.replied[0].mailbox, 'box@x')
  assert.equal(s.replied[0].graphMessageId, graphId)
  assert.match(s.replied[0].bodyText, /Bonjour Marie/)

  const { rows } = await db.query(`SELECT email_sent_at FROM ticket_messages WHERE id = $1`, [msgId])
  assert.ok(rows[0].email_sent_at, 'email_sent_at doit être posé après envoi')
})

test('flushOutbox : fallback sendMail si pas de graph_message_id (sans headers In-Reply-To)', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid, { from: 'bob@example.com', subject: 'Vieux thread', graphId: null })
  await seedMessage(tid, { content: 'Réponse au vieux thread' })

  const s = stubs()
  const stats = await flushOutbox(db, null, s.opts)
  assert.equal(stats.sent, 1)
  assert.equal(s.replied.length, 0)
  assert.equal(s.sent.length, 1, 'fallback sendMail utilisé')
  assert.equal(s.sent[0].to, 'bob@example.com')
  assert.equal(s.sent[0].sender, 'sender@example.com')
  assert.match(s.sent[0].subject, /^\[Opale #[A-F0-9]{8}\] Vieux thread$/)
  // Plus aucun header In-Reply-To/References (rejetés par Graph).
  assert.equal(s.sent[0].inReplyTo, undefined)
  assert.equal(s.sent[0].references, undefined)
})

test('flushOutbox : createReply 404 (mail d\'origine supprimé) → fallback sendMail', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid, { from: 'gone@example.com', subject: 'Thread perdu' })
  await seedMessage(tid, { content: 'Réponse malgré tout' })

  const sent = []
  const reply404 = async () => { throw new Error('Graph sendReply/createReply: 404 — ItemNotFound') }
  const stats = await flushOutbox(db, null, { sendReplyImpl: reply404, sendImpl: stubSend(sent) })

  assert.equal(stats.sent, 1, 'le mail part via le fallback')
  assert.equal(stats.errors, 0)
  assert.equal(sent.length, 1, 'sendMail (fallback) appelé après le 404')
  assert.equal(sent[0].to, 'gone@example.com')
  assert.equal(sent[0].inReplyTo, undefined)
})

test('flushOutbox : createReply erreur transitoire (5xx) → PAS de fallback, retry', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  const msgId = await seedMessage(tid, { content: 'Erreur transitoire' })

  const sent = []
  const reply503 = async () => { throw new Error('Graph sendReply/createReply: 503 — throttled') }
  const stats = await flushOutbox(db, null, { sendReplyImpl: reply503, sendImpl: stubSend(sent) })

  assert.equal(stats.errors, 1)
  assert.equal(stats.sent, 0)
  assert.equal(sent.length, 0, 'pas de fallback sur erreur transitoire')
  const { rows } = await db.query(`SELECT email_sent_at, outbound_attempts, outbound_failed_at FROM ticket_messages WHERE id = $1`, [msgId])
  assert.equal(rows[0].email_sent_at, null, 'retry possible au prochain tick')
  assert.equal(rows[0].outbound_attempts, 1, 'compteur incrémenté')
  assert.equal(rows[0].outbound_failed_at, null, 'pas encore dead-letter')
})

test('flushOutbox : échec persistant → dead-letter après MAX_ATTEMPTS, plus repris', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  const msgId = await seedMessage(tid, { content: 'Toujours en erreur' })

  const reply503 = async () => { throw new Error('Graph sendReply/createReply: 503 — throttled') }
  // 5 ticks d'échec → au 5e, dead-letter.
  let lastStats
  for (let i = 0; i < 5; i++) {
    lastStats = await flushOutbox(db, null, { sendReplyImpl: reply503, sendImpl: async () => ({}) })
  }
  assert.equal(lastStats.dead_letter, 1, 'le 5e échec marque dead-letter')

  const { rows } = await db.query(`SELECT outbound_attempts, outbound_failed_at, outbound_error FROM ticket_messages WHERE id = $1`, [msgId])
  assert.equal(rows[0].outbound_attempts, 5)
  assert.ok(rows[0].outbound_failed_at, 'outbound_failed_at posé')
  assert.match(rows[0].outbound_error, /503/)

  // Tick suivant : le message n'est PLUS repris (exclu par pickPending).
  let reprised = false
  await flushOutbox(db, null, { sendReplyImpl: async () => { reprised = true; return {} }, sendImpl: async () => { reprised = true; return {} } })
  assert.equal(reprised, false, 'dead-letter ignoré par le worker')
})

test('flushOutbox : loop-protection — message inbound déjà marqué non renvoyé', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  await seedMessage(tid, { content: 'Vient du mail entrant', emailSentAt: new Date() })

  const s = stubs()
  const stats = await flushOutbox(db, null, s.opts)
  assert.equal(stats.sent, 0)
  assert.equal(s.replied.length + s.sent.length, 0)
})

test('flushOutbox : ticket sans origine mail → pas d\'envoi', { skip: SKIP }, async () => {
  const tid = await seedTicket('Ticket purement interne')
  await seedMessage(tid, { content: 'Note interne' })

  const s = stubs()
  const stats = await flushOutbox(db, null, s.opts)
  assert.equal(stats.sent, 0)
  assert.equal(s.replied.length + s.sent.length, 0)
})

test('flushOutbox : type system ignoré', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  await seedMessage(tid, { type: 'system', content: 'Ticket pris en charge' })

  const s = stubs()
  const stats = await flushOutbox(db, null, s.opts)
  assert.equal(stats.sent, 0)
})

test('flushOutbox : échec d\'envoi → email_sent_at réinitialisé pour retry', { skip: SKIP }, async () => {
  const tid = await seedTicket()
  await seedInboundMapping(tid)
  const msgId = await seedMessage(tid, { content: 'À renvoyer' })

  const flakyReply = async () => { throw new Error('Graph 500') }
  const stats = await flushOutbox(db, null, { sendReplyImpl: flakyReply, sendImpl: flakyReply })
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

    const s = stubs()
    const stats = await flushOutbox(db, null, s.opts)
    assert.equal(stats.skipped, 'disabled')
    assert.equal(s.replied.length + s.sent.length, 0)
  } finally {
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'mail.send_enabled'`)
  }
})

test('flushOutbox : sender vide → skip avec raison', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value = '' WHERE key = 'mail.sender_address'`)
  try {
    const stats = await flushOutbox(db, null, { sendImpl: async () => ({}), sendReplyImpl: async () => ({}) })
    assert.equal(stats.skipped, 'no-sender-configured')
  } finally {
    await db.query(`UPDATE settings SET value = 'sender@example.com' WHERE key = 'mail.sender_address'`)
  }
})

test('flushOutbox : multi-inbound → reply cible le dernier mail Graph du fil', { skip: SKIP }, async () => {
  // Cas escalade : Marie écrit, puis Paul rejoint. La réponse threadée doit
  // partir du DERNIER mail inbound (celui de Paul) → Graph répondra dans le
  // bon fil au bon interlocuteur.
  const tid = await seedTicket()
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, graph_message_id, mailbox, direction, from_address, received_at, ticket_id)
    VALUES
      ('<m1@x>', 'graph-m1', 'box@x', 'inbound', 'marie@example.com', '2026-05-01', $1),
      ('<m2@x>', 'graph-m2', 'box@x', 'inbound', 'paul@example.com',  '2026-05-10', $1)
  `, [tid])
  await seedMessage(tid, { content: 'Réponse au dernier' })

  const s = stubs()
  await flushOutbox(db, null, s.opts)
  assert.equal(s.replied.length, 1)
  assert.equal(s.replied[0].graphMessageId, 'graph-m2', 'cible le dernier mail inbound')
})
