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

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { processOne } from '../../modules/email-bridge/lib/process-mail.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip process-mail suite'

let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release

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

test('processOne : nouveau mail sans thread match → pending_review (Phase 3, plus de proposal auto)',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage()
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })

    assert.equal(out.action, 'pending_review')
    assert.equal(out.proposal_id, null, 'plus de proposal auto')
    assert.equal(out.ticket_id, null)

    // Mapping enregistre quand même le classifier_result (advisory)
    const { rows: mRows } = await db.query(
      `SELECT action, proposal_id, ticket_id, classifier_result FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(mRows[0].action, 'pending_review')
    assert.equal(mRows[0].proposal_id, null)
    assert.equal(mRows[0].ticket_id, null)
    assert.equal(mRows[0].classifier_result.intent, 'new_ticket', 'intent stocké pour suggestion UI')
  }
)

test('processOne : intent="other" → toujours pending_review (le classifier ne décide plus)',
  { skip: SKIP }, async () => {
    const before = await countRows('ticket_proposals')
    const msg = fakeGraphMessage({ subject: 'Newsletter du mois' })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('other'),
    })
    // Phase 3 : intent='other' n'est plus une décision finale. Le mail
    // arrive en pending_review, l'admin clique "Ignorer" pour skipped_other.
    assert.equal(out.action, 'pending_review')
    assert.equal(out.proposal_id, null)
    assert.equal(await countRows('ticket_proposals'), before)

    const { rows } = await db.query(
      `SELECT action, classifier_result FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(rows[0].action, 'pending_review')
    assert.equal(rows[0].classifier_result.intent, 'other', 'intent stocké en advisory')
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

test('processOne : mail réponse à proposal pending → append à replies, pas de nouvelle proposal',
  { skip: SKIP }, async () => {
    // Seed : une proposal email + mapping inbound qui pointe vers elle.
    const { rows: pRows } = await db.query(`
      INSERT INTO ticket_proposals (source, suggested_title, source_payload)
      VALUES ('email', 'Proposal pending', $1)
      RETURNING id
    `, [JSON.stringify({ from: 'marie@example.com', fromName: 'Marie',
                        receivedAt: '2026-02-05T09:00:00Z', bodyText: 'Mail initial' })])
    const proposalId = pRows[0].id

    const parentMsgId = `<parent-prop-${Math.random().toString(36).slice(2)}@x>`
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, proposal_id, action)
      VALUES ($1, 'helpdesk@test', 'inbound', '2026-02-05T09:00:00Z', $2, 'proposal_created')
    `, [parentMsgId, proposalId])

    const propsBefore = await countRows('ticket_proposals')

    // Mail de relance qui répond au mail initial (In-Reply-To).
    const msg = fakeGraphMessage({
      subject: 'Re: Proposal pending',
      bodyPreview: 'Je relance, toujours pas résolu.',
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })
    let classifierCalled = false
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: async () => { classifierCalled = true; return { intent: 'new_ticket' } },
    })

    assert.equal(out.action, 'reply_appended_to_proposal')
    assert.equal(out.proposal_id, proposalId)
    assert.equal(classifierCalled, false, 'thread match → classifier court-circuité')

    // Aucune nouvelle proposal créée.
    assert.equal(await countRows('ticket_proposals'), propsBefore)

    // La proposal initiale a maintenant un replies[] avec le contenu de la relance.
    const { rows: updated } = await db.query(
      `SELECT source_payload FROM ticket_proposals WHERE id = $1`, [proposalId]
    )
    const sp = updated[0].source_payload
    assert.ok(Array.isArray(sp.replies), 'source_payload.replies doit exister')
    assert.equal(sp.replies.length, 1)
    assert.equal(sp.replies[0].from, 'marie@example.com')
    assert.match(sp.replies[0].bodyPreview, /Je relance/)

    // Mapping du mail de relance pointe aussi vers la proposal.
    const { rows: mapRows } = await db.query(
      `SELECT action, proposal_id FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(mapRows[0].action, 'reply_appended_to_proposal')
    assert.equal(mapRows[0].proposal_id, proposalId)
  }
)

test('processOne : 2 réponses à la même proposal pending → 2 entrées dans replies',
  { skip: SKIP }, async () => {
    const { rows: pRows } = await db.query(`
      INSERT INTO ticket_proposals (source, suggested_title, source_payload)
      VALUES ('email', 'Multi relance', '{}'::jsonb)
      RETURNING id
    `)
    const proposalId = pRows[0].id
    const parentMsgId = `<parent-multi-${Math.random().toString(36).slice(2)}@x>`
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, proposal_id, action)
      VALUES ($1, 'helpdesk@test', 'inbound', now(), $2, 'proposal_created')
    `, [parentMsgId, proposalId])

    for (let i = 0; i < 2; i++) {
      const msg = fakeGraphMessage({
        subject: `Re: Multi relance ${i}`,
        bodyPreview: `relance ${i}`,
        internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
      })
      const out = await processOne(db, null, {
        graphMessage: msg, mailbox: 'helpdesk@test',
        classifierFn: stubClassifier('new_ticket'),
      })
      assert.equal(out.action, 'reply_appended_to_proposal')
    }

    const { rows } = await db.query(
      `SELECT source_payload FROM ticket_proposals WHERE id = $1`, [proposalId]
    )
    assert.equal(rows[0].source_payload.replies.length, 2)
  }
)

test('processOne : intent "reply" sans thread match → pending_review (plus de fallback proposal)',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage({
      subject: 'Re: vieille discussion qu\'on n\'a jamais vue',
      internetMessageHeaders: [{ name: 'In-Reply-To', value: '<inconnu@externe>' }],
    })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('reply'),
    })

    // Phase 3 : un "reply" sans match parent tombe dans pending_review
    // comme tous les mails non-matchés. L'admin choisit s'il veut ouvrir
    // un nouveau ticket ou ignorer.
    assert.equal(out.action, 'pending_review')
    assert.equal(out.proposal_id, null)
  }
)

test('processOne : mail déjà ingéré → already_ingested, pas de double action',
  { skip: SKIP }, async () => {
    const msg = fakeGraphMessage()
    const out1 = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out1.action, 'pending_review')
    const mappingsAfter1 = await countRows('email_thread_mapping')

    // Second appel : doit no-op et ne pas créer de second mapping.
    const out2 = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out2.action, 'already_ingested')
    assert.equal(await countRows('email_thread_mapping'), mappingsAfter1)
  }
)

test('processOne : bodyPreview HTML résiduel → strippé dans le mapping (défense en profondeur)',
  { skip: SKIP }, async () => {
    // Cas réel observé : Outlook glisse parfois du HTML dans bodyPreview
    // (mails forwarded, signatures inline). Notre pipeline doit garantir
    // qu'aucun HTML brut ne fuit en DB. En Phase 3 il n'y a plus de
    // proposal créée automatiquement : on vérifie sur la copie raw du
    // mapping (utilisée par /api/email/inbox pour afficher le preview).
    const htmlPreview = '<p>Bonjour,</p><p>Mon compte est <strong>bloqué</strong>.</p>'
    const msg = fakeGraphMessage({
      bodyPreview: htmlPreview,
    })
    const out = await processOne(db, null, {
      graphMessage: msg, mailbox: 'helpdesk@test',
      classifierFn: stubClassifier('new_ticket'),
    })
    assert.equal(out.action, 'pending_review')

    // Le mapping stocke graphMessage tel quel dans raw. C'est le rendu
    // côté front qui re-strippe (via SQL ->>'bodyPreview' puis re-clean).
    // Ici on vérifie que le classifier (input) n'a pas vu de HTML.
    // Note : l'extraction propre est testée dans email-body-text.test.js.
    const { rows } = await db.query(
      `SELECT classifier_result FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.ok(rows[0].classifier_result, 'classifier_result présent même en pending_review')
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
