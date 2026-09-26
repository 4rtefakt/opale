// Tests d'intégration du worker de polling des Éléments envoyés
// (pollSentOnce) : curseur et reprise. Graph est simulé au niveau fetch()
// (helpers/fake-graph-mail.js) : vrais listSentMessagesSince et getMessage,
// sans aucun appel réseau.
//
// Chemins critiques (même logique de curseur que l'inbound, poll-cursor.js) :
//   - transaction en échec sur une réponse threadée → curseur arrêté avant
//     elle, retentée au tick suivant, aucune réponse ajoutée en double
//   - réponse visible plus tard au même sentDateTime que le curseur →
//     ajoutée ; la précédente n'est pas retraitée (pas de getMessage rejoué)
//
// Échec de transaction : trigger de test sur email_thread_mapping (INSERT
// refusé pour les internet_message_id listés dans test_failing_mail).

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { installFakeGraph, graphTime, fakeMail } from '../helpers/fake-graph-mail.js'
import { pollSentOnce } from '../../modules/email-bridge/lib/sent-poll-worker.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip sent-poll-worker suite'

const MAILBOX = 'agent@example.com'
const T0 = '2026-05-10T09:00:00.000Z'
const at = s => graphTime(T0, s)
const CONV = 'conv-ticket-existant'

let db, release, graph, ticketId

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  await db.query(`UPDATE settings SET value = 'true' WHERE key = 'mail.sent_poll_enabled'`)
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'mail.sent_mailboxes'`, [MAILBOX])

  await db.query(`CREATE TABLE test_failing_mail (internet_message_id TEXT PRIMARY KEY)`)
  await db.query(`
    CREATE FUNCTION test_fail_mapping_insert() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM test_failing_mail WHERE internet_message_id = NEW.internet_message_id) THEN
        RAISE EXCEPTION 'échec simulé pour %', NEW.internet_message_id;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)
  await db.query(`
    CREATE TRIGGER test_fail_mapping_insert BEFORE INSERT ON email_thread_mapping
    FOR EACH ROW EXECUTE FUNCTION test_fail_mapping_insert()
  `)
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

beforeEach(async () => {
  if (SKIP) return
  await db.query(`TRUNCATE TABLE email_thread_mapping, ticket_messages, tickets CASCADE`)
  await db.query(`TRUNCATE TABLE test_failing_mail`)
  await db.query(`DELETE FROM settings WHERE key LIKE 'mail.sent_cursor%'`)
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2)`, [`mail.sent_cursor.${MAILBOX}`, T0])

  // Ticket ouvert par mail : les réponses de la même conversation s'y rattachent.
  const { rows } = await db.query(`INSERT INTO tickets (title) VALUES ('Imprimante') RETURNING id`)
  ticketId = rows[0].id
  await db.query(`
    INSERT INTO email_thread_mapping (internet_message_id, conversation_id, mailbox, direction, received_at, ticket_id)
    VALUES ('<origine@example.com>', $1, 'helpdesk@example.com', 'inbound', now(), $2)
  `, [CONV, ticketId])
})

// Réponse envoyée depuis Outlook dans le fil du ticket, contenu distinct.
function sentReply(s, text) {
  return fakeMail({
    sentDateTime: at(s), conversationId: CONV, subject: 'RE: Imprimante', bodyPreview: text,
    from: { emailAddress: { address: MAILBOX, name: 'Agent' } },
  })
}

async function ticketContents() {
  const { rows } = await db.query(
    `SELECT content FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at, content`, [ticketId]
  )
  return rows.map(r => r.content)
}

async function cursorMs() {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [`mail.sent_cursor.${MAILBOX}`])
  return Date.parse(rows[0].value)
}

test('pollSentOnce : transaction en échec sur une réponse → retentée au tick suivant, sans doublon',
  { skip: SKIP }, async () => {
    const a = sentReply(1, 'Réponse A')
    const b = sentReply(2, 'Réponse B')
    const c = sentReply(3, 'Réponse C')
    graph = installFakeGraph({ sent: [a, b, c] })
    await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [b.internetMessageId])
    try {
      const first = await pollSentOnce(db, null)
      assert.equal(first.actions.skipped_error, 1, 'processSentOne a bien échoué sur B (ROLLBACK)')
      assert.ok(!(await ticketContents()).includes('Réponse B'))
      assert.equal(await cursorMs(), Date.parse(at(1)), 'curseur arrêté juste avant la réponse en échec')

      await db.query(`TRUNCATE TABLE test_failing_mail`)
      const second = await pollSentOnce(db, null)
      assert.deepEqual(await ticketContents(), ['Réponse A', 'Réponse B', 'Réponse C'],
        'B rattrapée, A pas ajoutée une seconde fois')
      assert.equal(second.actions.already_ingested, 0, 'A n\'est pas retraitée')
      assert.equal(await cursorMs(), Date.parse(at(3)))
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : réponse visible plus tard au même sentDateTime que le curseur → ajoutée, sans rejouer la précédente',
  { skip: SKIP }, async () => {
    const first = sentReply(5, 'Première réponse')
    graph = installFakeGraph({ sent: [first] })
    try {
      await pollSentOnce(db, null)
      assert.deepEqual(await ticketContents(), ['Première réponse'])

      const late = sentReply(5, 'Réponse de la même seconde')
      graph.sent.push(late)
      await pollSentOnce(db, null)
      assert.deepEqual((await ticketContents()).sort(), ['Première réponse', 'Réponse de la même seconde'].sort())

      const fetchedFirst = graph.calls.filter(u => u.includes(`/messages/${encodeURIComponent(first.id)}`))
      assert.equal(fetchedFirst.length, 1, 'le corps de la première réponse n\'est pas re-téléchargé')
    } finally {
      graph.restore()
    }
  }
)
