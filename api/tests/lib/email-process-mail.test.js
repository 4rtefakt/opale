// Tests d'intégration du pipeline processOne (Phase 3, issue #8).
//
// Couvre les chemins critiques :
//   - Mail nouveau, intent='new_ticket' → proposition créée, user/device matchés
//   - Mail nouveau, intent='other'     → mapping seule, pas de proposition
//   - Mail réponse, thread matché      → message ajouté au ticket
//   - Mail nouveau, intent='reply' mais aucun thread → proposition (fallback)
//   - Mail déjà ingéré                 → no-op (idempotence)
//
// Le classifieur est injecté en stub — pas d'appel HTTP. Le helper
// `acquireSchema` rejoue toutes les migrations, donc la table
// email_thread_mapping a bien les colonnes Phase 2/3.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { processOne } from '../../modules/email-bridge/lib/process-mail.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip process-mail suite'

let schema, db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  // Activer le classifieur côté settings (on injecte un stub donc l'URL/model
  // bidons ne sont pas appelés). Sans `enabled=true`, classifySafe retourne
  // directement le fallback et n'invoque pas le classifierFn injecté.
  await db.query(`UPDATE settings SET value = 'true'    WHERE key = 'mail.classifier.enabled'`)
  await db.query(`UPDATE settings SET value = 'http://stub' WHERE key = 'mail.classifier.url'`)
  await db.query(`UPDATE settings SET value = 'stub-model' WHERE key = 'mail.classifier.model'`)
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeGraphMessage(overrides = {}) {
  const tag = Math.random().toString(36).slice(2)
  return {
    id: `graph-id-${tag}`,
    internetMessageId: `<${tag}@x>`,
    // Important : conversationId unique par mail par défaut, sinon les
    // tests qui seedent des mappings se contamineraient les uns les autres
    // via le fallback "match par conversationId".
    conversationId: `conv-${tag}`,
    from: { emailAddress: { address: 'marie@example.com', name: 'Marie' } },
    subject: 'Imprimante bloque',
    bodyPreview: 'Elle bloque encore.',
    receivedDateTime: new Date().toISOString(),
    hasAttachments: false,
    internetMessageHeaders: [],
    ...overrides,
  }
}

function stubClassifier(intent, { confidence = 0.9, reason = 'stub' } = {}) {
  return async () => ({ intent, confidence, reason })
}

async function countRows(table) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)
  return rows[0].n
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('processOne : nouveau mail "new_ticket" → proposition créée, user+device matchés',
  { skip: SKIP }, async () => {
    await db.query(`
      INSERT INTO users_cache (entra_id, email, display_name)
      VALUES ('entra-marie-pt1', 'marie@example.com', 'Marie')
      ON CONFLICT (entra_id) DO NOTHING
    `)
    const { rows: dRows } = await db.query(`
      INSERT INTO devices (hostname, assigned_user_id) VALUES ('PC-MARIE', 'entra-marie-pt1') RETURNING id
    `)
    const deviceId = dRows[0].id

    const msg = fakeGraphMessage()
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })

    assert.equal(out.action, 'proposal_created')
    assert.ok(out.proposal_id)
    assert.equal(out.intent, 'new_ticket')

    const { rows: pRows } = await db.query(
      `SELECT suggested_user_id, suggested_device_id, source FROM ticket_proposals WHERE id = $1`,
      [out.proposal_id]
    )
    assert.equal(pRows[0].source, 'email')
    assert.equal(pRows[0].suggested_user_id, 'entra-marie-pt1')
    assert.equal(pRows[0].suggested_device_id, deviceId)

    // Mapping row existe et pointe vers la proposition.
    const { rows: mRows } = await db.query(
      `SELECT action, proposal_id, ticket_id FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(mRows[0].action, 'proposal_created')
    assert.equal(mRows[0].proposal_id, out.proposal_id)
    assert.equal(mRows[0].ticket_id, null)
  }
)

test('processOne : mail "other" → mapping seule, pas de proposition',
  { skip: SKIP }, async () => {
    const before = await countRows('ticket_proposals')
    const msg = fakeGraphMessage({ subject: 'Newsletter du mois' })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('other'),
    })
    assert.equal(out.action, 'skipped_other')
    assert.equal(out.proposal_id, null)
    assert.equal(await countRows('ticket_proposals'), before)

    const { rows } = await db.query(
      `SELECT action FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(rows[0].action, 'skipped_other')
  }
)

test('processOne : mail "reply" matché par In-Reply-To → message ajouté au ticket',
  { skip: SKIP }, async () => {
    // Seed : ticket + mapping pointant vers ce ticket
    const { rows: tRows } = await db.query(
      `INSERT INTO tickets (title) VALUES ('Old ticket') RETURNING id`
    )
    const ticketId = tRows[0].id

    const parentMsgId = `<parent-${Math.random().toString(36).slice(2)}@x>`
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, ticket_id)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2)
    `, [parentMsgId, ticketId])

    const msg = fakeGraphMessage({
      subject: 'Re: imprimante',
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })
    // Note : on n'invoque PAS le classifieur, le thread match court-circuite.
    let classifierCalled = false
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: async () => { classifierCalled = true; return { intent: 'reply' } },
    })

    assert.equal(out.action, 'message_appended')
    assert.equal(out.ticket_id, ticketId)
    assert.equal(classifierCalled, false, 'classifieur NE doit PAS être appelé si thread match')

    // Un message a été ajouté au ticket.
    const { rows: msgRows } = await db.query(
      `SELECT type, author, content FROM ticket_messages WHERE ticket_id = $1`,
      [ticketId]
    )
    assert.equal(msgRows.length, 1)
    assert.equal(msgRows[0].type, 'comment')
    assert.match(msgRows[0].content, /bloque encore/i)
  }
)

test('processOne : intent "reply" sans thread match → proposition_created_no_match',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage({
      subject: 'Re: vieille discussion qu\'on n\'a jamais vue',
      internetMessageHeaders: [{ name: 'In-Reply-To', value: '<inconnu@externe>' }],
    })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('reply'),
    })

    assert.equal(out.action, 'proposal_created_no_match')
    assert.ok(out.proposal_id)
    assert.equal(out.intent, 'reply')
  }
)

test('processOne : mail déjà ingéré → already_ingested, pas de double action',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage()
    const out1 = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out1.action, 'proposal_created')
    const proposalsAfter1 = await countRows('ticket_proposals')

    // Second appel : doit no-op et ne pas créer de second proposal.
    const out2 = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out2.action, 'already_ingested')
    assert.equal(await countRows('ticket_proposals'), proposalsAfter1)
  }
)

test('processOne : mail sans internetMessageId → skipped_error',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage({ internetMessageId: undefined })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out.action, 'skipped_error')
    assert.match(out.error, /internetMessageId/)
  }
)
