// Tests d'intégration du pipeline processSentOne (ingestion des réponses
// envoyées depuis Outlook hors Opale).
//
// Chemins critiques :
//   - mail threadé à un ticket existant   → message 'comment' ajouté, déjà
//     envoyé (email_sent_at), auteur résolu, corps strippé du bloc cité
//   - mail sans thread match               → skipped_no_match, AUCUNE écriture
//   - mail threadé à une proposal (pas un ticket) → skipped_no_match
//   - mail déjà ingéré                     → already_ingested, pas de doublon
//   - mail sans internetMessageId          → skipped_error
//
// getMessageFn est injecté pour fournir le corps complet sans appel Graph.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { processSentOne } from '../../modules/email-bridge/lib/process-sent-mail.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip sent-process suite'

let db, release

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

function fakeSentMessage(overrides = {}) {
  const tag = Math.random().toString(36).slice(2)
  return {
    id: `graph-id-${tag}`,
    internetMessageId: `<sent-${tag}@tdv>`,
    conversationId: `conv-${tag}`,
    from: { emailAddress: { address: 'agent@tourduvalat.org', name: 'Agent' } },
    subject: 'RE: imprimante bloquée',
    bodyPreview: 'Voici la marche à suivre.',
    sentDateTime: '2026-05-10T09:30:00Z',
    hasAttachments: false,
    internetMessageHeaders: [],
    ...overrides,
  }
}

// getMessage stub : corps HTML avec réponse neuve + bloc cité Outlook que
// extractMailBodyText doit couper.
function stubGetMessage(reply) {
  return async () => ({
    body: {
      contentType: 'html',
      content:
        `<p>${reply}</p>` +
        `<p>De : Marie &lt;marie@example.com&gt;<br>Envoyé : lundi<br>À : agent@tourduvalat.org</p>` +
        `<p>Texte original cité qu'on ne veut PAS garder.</p>`,
    },
  })
}

async function seedTicketWithThread(parentMsgId) {
  const { rows: tRows } = await db.query(
    `INSERT INTO tickets (title) VALUES ('Ticket existant') RETURNING id`
  )
  const ticketId = tRows[0].id
  await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, received_at, ticket_id)
    VALUES ($1, 'helpdesk@tourduvalat.org', 'inbound', now(), $2)
  `, [parentMsgId, ticketId])
  return ticketId
}

test('processSentOne : mail threadé à un ticket → message ajouté, déjà envoyé',
  { skip: SKIP }, async () => {
    // L'agent est dans users_cache → l'auteur doit être son display_name.
    await db.query(`
      INSERT INTO users_cache (entra_id, display_name, email)
      VALUES ('agent-entra', 'Clément Boutin', 'agent@tourduvalat.org')
      ON CONFLICT (entra_id) DO NOTHING
    `)
    const parentMsgId = `<parent-${Math.random().toString(36).slice(2)}@x>`
    const ticketId = await seedTicketWithThread(parentMsgId)

    const msg = fakeSentMessage({
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })
    const out = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('Bonjour, voici la solution détaillée.'),
    })

    assert.equal(out.action, 'message_appended')
    assert.equal(out.ticket_id, ticketId)

    const { rows: msgRows } = await db.query(
      `SELECT type, author, content, email_sent_at, created_at
       FROM ticket_messages WHERE ticket_id = $1`, [ticketId]
    )
    assert.equal(msgRows.length, 1)
    assert.equal(msgRows[0].type, 'comment')
    assert.equal(msgRows[0].author, 'Clément Boutin', 'auteur résolu via users_cache')
    assert.ok(msgRows[0].email_sent_at, 'email_sent_at posé → outbox ne renvoie pas')
    // created_at = sentDateTime (placement chronologique, pas now()).
    assert.equal(new Date(msgRows[0].created_at).toISOString(), '2026-05-10T09:30:00.000Z')
    // Corps : réponse neuve gardée, bloc cité Outlook coupé.
    assert.match(msgRows[0].content, /solution détaillée/)
    assert.doesNotMatch(msgRows[0].content, /ne veut PAS garder/)

    // Mapping outbound enregistré, rattaché au ticket.
    const { rows: mapRows } = await db.query(
      `SELECT direction, action, ticket_id FROM email_thread_mapping WHERE internet_message_id = $1`,
      [msg.internetMessageId]
    )
    assert.equal(mapRows[0].direction, 'outbound')
    assert.equal(mapRows[0].action, 'message_appended')
    assert.equal(mapRows[0].ticket_id, ticketId)
  }
)

test('processSentOne : sans thread match → skipped_no_match, aucune écriture',
  { skip: SKIP }, async () => {
    const msg = fakeSentMessage({
      internetMessageHeaders: [{ name: 'In-Reply-To', value: '<inconnu@externe>' }],
    })
    const mapBefore = (await db.query('SELECT COUNT(*)::int n FROM email_thread_mapping')).rows[0].n
    const msgBefore = (await db.query('SELECT COUNT(*)::int n FROM ticket_messages')).rows[0].n

    const out = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('peu importe'),
    })

    assert.equal(out.action, 'skipped_no_match')
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM email_thread_mapping')).rows[0].n, mapBefore,
      'pas de ligne mapping pour un mail perso non lié')
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM ticket_messages')).rows[0].n, msgBefore)
  }
)

test('processSentOne : threadé à une proposal (pas un ticket) → skipped_no_match',
  { skip: SKIP }, async () => {
    const { rows: pRows } = await db.query(`
      INSERT INTO ticket_proposals (source, suggested_title, source_payload)
      VALUES ('email', 'Proposal pending', '{}'::jsonb) RETURNING id
    `)
    const parentMsgId = `<prop-${Math.random().toString(36).slice(2)}@x>`
    await db.query(`
      INSERT INTO email_thread_mapping
        (internet_message_id, mailbox, direction, received_at, proposal_id, action)
      VALUES ($1, 'helpdesk@tourduvalat.org', 'inbound', now(), $2, 'proposal_created')
    `, [parentMsgId, pRows[0].id])

    const msg = fakeSentMessage({
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })
    const out = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('peu importe'),
    })
    assert.equal(out.action, 'skipped_no_match', 'une proposal n\'est pas un ticket existant')
  }
)

test('processSentOne : mail déjà ingéré → already_ingested, pas de doublon',
  { skip: SKIP }, async () => {
    const parentMsgId = `<parent-${Math.random().toString(36).slice(2)}@x>`
    const ticketId = await seedTicketWithThread(parentMsgId)
    const msg = fakeSentMessage({
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })

    const out1 = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('première fois'),
    })
    assert.equal(out1.action, 'message_appended')

    const out2 = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('seconde fois'),
    })
    assert.equal(out2.action, 'already_ingested')

    const { rows } = await db.query(
      `SELECT COUNT(*)::int n FROM ticket_messages WHERE ticket_id = $1`, [ticketId]
    )
    assert.equal(rows[0].n, 1, 'un seul message malgré le double passage')
  }
)

test('processSentOne : réponse déjà envoyée DEPUIS Opale → skipped_duplicate, pas de doublon',
  { skip: SKIP }, async () => {
    // Reproduit le bug : sender_address = boîte scannée. Le message a déjà été
    // créé dans Opale (texte saisi par l'agent), puis l'envoi Graph l'a déposé
    // dans les Éléments envoyés. Le sent-worker le retrouve → ne doit PAS le
    // ré-ajouter. Le contenu en DB diffère du HTML ré-extrait par des blancs.
    const parentMsgId = `<parent-${Math.random().toString(36).slice(2)}@x>`
    const ticketId = await seedTicketWithThread(parentMsgId)
    // Message déjà présent (origine Opale), avec des blancs différents.
    await db.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
      VALUES ($1, 'comment', 'Clément Boutin', $2, now())
    `, [ticketId, 'Bonjour,\n\nVoici la solution.\n\nCordialement'])

    const msg = fakeSentMessage({
      internetMessageHeaders: [{ name: 'In-Reply-To', value: parentMsgId }],
    })
    // Le corps ré-extrait : même texte, blancs différents (espaces multiples).
    const out = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: async () => ({ body: { contentType: 'html',
        content: '<p>Bonjour,</p><p>Voici la   solution.</p><p>Cordialement</p>' } }),
    })

    assert.equal(out.action, 'skipped_duplicate')
    const { rows } = await db.query(
      `SELECT COUNT(*)::int n FROM ticket_messages WHERE ticket_id = $1`, [ticketId]
    )
    assert.equal(rows[0].n, 1, 'le message Opale d\'origine reste seul, pas de doublon')

    // Et aucun mapping outbound écrit pour un doublon.
    const { rows: m } = await db.query(
      `SELECT 1 FROM email_thread_mapping WHERE internet_message_id = $1`, [msg.internetMessageId]
    )
    assert.equal(m.length, 0)
  }
)

test('processSentOne : mail sans internetMessageId → skipped_error',
  { skip: SKIP }, async () => {
    const msg = fakeSentMessage({ internetMessageId: undefined })
    const out = await processSentOne(db, null, {
      graphMessage: msg, mailbox: 'agent@tourduvalat.org',
      getMessageFn: stubGetMessage('x'),
    })
    assert.equal(out.action, 'skipped_error')
    assert.match(out.error, /internetMessageId/)
  }
)
