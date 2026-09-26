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
//   - panne systémique d'écriture, réponses threadées entrecoupées de mails
//     non rattachés (skipped_no_match : rien d'écrit) → aucun abandon
//
// Échec de transaction : trigger de test sur email_thread_mapping (INSERT
// refusé pour les internet_message_id listés dans test_failing_mail).

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { installFakeGraph, graphTime, fakeMail } from '../helpers/fake-graph-mail.js'
import { pollSentOnce } from '../../modules/email-bridge/lib/sent-poll-worker.js'
import { MIN_POISON_AGE_MS, SUSPECT_ALERT_MS } from '../../modules/email-bridge/lib/poll-cursor.js'

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
  await db.query(`DELETE FROM audit_logs WHERE action LIKE 'mail_ingest%'`)
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

test('pollSentOnce : caractère NUL dans le sujet et le corps d\'une réponse → ajoutée au ticket, NUL retiré',
  { skip: SKIP }, async () => {
    const reply = sentReply(1, 'Voici\u0000 la marche à suivre.')
    reply.subject = 'RE: Impri\u0000mante'
    graph = installFakeGraph({ sent: [reply] })
    try {
      await pollSentOnce(db, null)
      assert.deepEqual(await ticketContents(), ['Voici la marche à suivre.'])
      const { rows } = await db.query(`SELECT subject FROM email_thread_mapping WHERE internet_message_id = $1`, [reply.internetMessageId])
      assert.equal(rows[0]?.subject, 'RE: Imprimante')
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : réponse poison suivie de 60 mails non rattachés puis d\'une réponse → verdict atteint, poison abandonnée',
  { skip: SKIP }, async () => {
    // Pendant qu'un suspect attend son verdict, les mails qui n'écrivent
    // rien ne consomment pas le budget de PAGE_SIZE mails du tick : sinon
    // 50 mails perso d'affilée empêcheraient pour toujours d'atteindre la
    // réponse suivante (boîte bloquée).
    const poison = sentReply(1, 'Réponse poison')
    const perso = Array.from({ length: 60 }, (_, i) => fakeMail({
      sentDateTime: at(2 + i), conversationId: `perso-${i}`, subject: `Perso ${i}`,
      from: { emailAddress: { address: MAILBOX } },
    }))
    const good = sentReply(100, 'Réponse suivante')
    graph = installFakeGraph({ sent: [poison, ...perso, good] })
    await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [poison.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      let abandoned = 0
      for (let tick = 0; tick < 8; tick++) {   // 40 min
        abandoned += (await pollSentOnce(db, null, { now })).abandoned
        t += 5 * 60_000
      }
      assert.equal(abandoned, 1, 'poison abandonnée une fois le verdict atteint')
      assert.deepEqual(await ticketContents(), ['Réponse suivante'])
      assert.equal(await cursorMs(), Date.parse(at(100)))
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : poison suivie de 260 réponses déjà présentes (doublons) puis d\'une réponse → verdict atteint, rien relu deux fois',
  { skip: SKIP }, async () => {
    // Plus de MAX_PAGES × PAGE_SIZE mails qui n'écrivent rien après le
    // suspect : la position provisoire est gardée d'un tick à l'autre (sinon
    // chaque tick repartait du suspect, relisait les mêmes 250 mails — un
    // getMessage Graph par doublon — et n'atteignait jamais le verdict).
    await db.query(`INSERT INTO ticket_messages (ticket_id, type, author, content) VALUES ($1, 'comment', 'Agent', 'Déjà envoyé depuis Opale')`, [ticketId])
    const poison = sentReply(1, 'Réponse poison')
    const dups = Array.from({ length: 260 }, (_, i) => sentReply(2 + i, 'Déjà envoyé depuis Opale'))
    const good = sentReply(400, 'Réponse suivante')
    graph = installFakeGraph({ sent: [poison, ...dups, good] })
    await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [poison.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      for (let tick = 0; tick < 9; tick++) {   // 45 min
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      assert.ok((await ticketContents()).includes('Réponse suivante'), 'réponse suivante ajoutée')
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
      assert.equal(rows[0].n, 1, 'poison abandonnée')
      // Au verdict, la plage parcourue est revue une fois (mails visibles en
      // retard) à 50 mails par tick : on laisse finir ce passage.
      for (let tick = 0; tick < 8 && await cursorMs() < Date.parse(at(400)); tick++) {
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      assert.equal(await cursorMs(), Date.parse(at(400)))
      // Pas de relecture à chaque tick pendant l'attente : au plus deux
      // lectures par doublon (recherche du verdict, puis passage au verdict).
      const refetched = dups.filter(d => graph.calls.filter(u => u.includes(`/messages/${encodeURIComponent(d.id)}`)).length > 2)
      assert.equal(refetched.length, 0, 'aucun doublon relu plus de deux fois (getMessage)')
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : verdict attendu sur plusieurs ticks puis échec du mail suivant → retour au point d\'avant le suspect, rien perdu',
  { skip: SKIP }, async () => {
    const poison = sentReply(1, 'Réponse A')
    const perso = Array.from({ length: 260 }, (_, i) => fakeMail({
      sentDateTime: at(2 + i), conversationId: `perso-${i}`, subject: `Perso ${i}`,
      from: { emailAddress: { address: MAILBOX } },
    }))
    const next = sentReply(400, 'Réponse B')
    graph = installFakeGraph({ sent: [poison, ...perso, next] })
    for (const r of [poison, next]) await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [r.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      for (let tick = 0; tick < 9; tick++) {
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
      assert.equal(rows[0].n, 0, 'le mail suivant échoue aussi : panne systémique, aucun abandon')
      assert.equal(await cursorMs(), Date.parse(T0), 'curseur resté avant le suspect')

      // Rétablissement : le suspect est retenté en tête (pas abandonné parce
      // que B écrit enfin) ; 262 mails à 50 par tick.
      await db.query(`TRUNCATE TABLE test_failing_mail`)
      for (let tick = 0; tick < 7; tick++) await pollSentOnce(db, null, { now })
      assert.deepEqual(await ticketContents(), ['Réponse A', 'Réponse B'])
      const { rows: after } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
      assert.equal(after[0].n, 0, 'le suspect n\'est pas abandonné au rétablissement')
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : réponse visible en retard DANS la plage déjà parcourue pour le verdict → ajoutée, sans doublon',
  { skip: SKIP }, async () => {
    // Outlook hors ligne : la réponse est synchronisée tard, avec un
    // sentDateTime (horloge du poste) entre le suspect et la position de
    // recherche gardée. La reprise à cette position ne la liste jamais : au
    // verdict, on repasse donc depuis juste après le suspect.
    const poison = sentReply(1, 'Réponse poison')
    const perso = Array.from({ length: 20 }, (_, i) => fakeMail({
      sentDateTime: at(10 + i), conversationId: `perso-${i}`, subject: `Perso ${i}`,
      from: { emailAddress: { address: MAILBOX } },
    }))
    graph = installFakeGraph({ sent: [poison, ...perso] })
    await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [poison.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      for (let tick = 0; tick < 8; tick++) {   // suspect ; recherche gardée après les 20 mails perso
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      graph.sent.push(sentReply(5, 'Réponse synchronisée en retard'), sentReply(100, 'Réponse suivante'))
      for (let tick = 0; tick < 4; tick++) {
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      assert.deepEqual(await ticketContents(), ['Réponse synchronisée en retard', 'Réponse suivante'], 'les deux ajoutées, une fois chacune')
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
      assert.equal(rows[0].n, 1, 'poison abandonnée')
      assert.equal(await cursorMs(), Date.parse(at(100)))
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : suspect sans verdict pendant plus de SUSPECT_ALERT_MS → UNE ligne d\'audit « boîte bloquée »',
  { skip: SKIP }, async () => {
    const poison = sentReply(1, 'Réponse poison')
    const perso = Array.from({ length: 5 }, (_, i) => fakeMail({
      sentDateTime: at(2 + i), conversationId: `perso-${i}`, subject: `Perso ${i}`,
      from: { emailAddress: { address: MAILBOX } },
    }))
    graph = installFakeGraph({ sent: [poison, ...perso] })
    await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [poison.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      const ticks = (MIN_POISON_AGE_MS + SUSPECT_ALERT_MS) / (5 * 60_000) + 6
      for (let tick = 0; tick < ticks; tick++) {
        await pollSentOnce(db, null, { now })
        t += 5 * 60_000
      }
      const { rows } = await db.query(`SELECT details FROM audit_logs WHERE action = 'mail_ingest_blocked'`)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].details.reason, 'waiting')
      assert.equal(rows[0].details.internet_message_id, poison.internetMessageId)
    } finally {
      graph.restore()
    }
  }
)

test('pollSentOnce : panne systémique d\'écriture, réponses entrecoupées de mails non rattachés → aucun abandon, tout rattrapé',
  { skip: SKIP }, async () => {
    // Un mail non rattaché (skipped_no_match) n'écrit rien : il ne prouve
    // pas que l'écriture fonctionne et ne doit pas servir de verdict.
    const replies = []
    const mails = []
    for (let i = 0; i < 6; i++) {
      const reply = sentReply(2 * i + 1, `Réponse ${i}`)
      replies.push(reply)
      mails.push(reply, fakeMail({
        sentDateTime: at(2 * i + 2), conversationId: `perso-${i}`, subject: `Perso ${i}`,
        from: { emailAddress: { address: MAILBOX } },
      }))
    }
    graph = installFakeGraph({ sent: mails })
    for (const r of replies) await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [r.internetMessageId])
    let t = Date.parse('2026-05-10T10:00:00Z')
    const now = () => t
    try {
      let abandoned = 0
      for (let tick = 0; tick < 36; tick++) {   // 3 h, un tick toutes les 5 min
        abandoned += (await pollSentOnce(db, null, { now })).abandoned
        t += 5 * 60_000
      }
      assert.equal(abandoned, 0)
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
      assert.equal(rows[0].n, 0)

      await db.query(`TRUNCATE TABLE test_failing_mail`)
      await pollSentOnce(db, null, { now })
      assert.deepEqual(await ticketContents(), replies.map((_, i) => `Réponse ${i}`), 'toutes les réponses rattrapées')
    } finally {
      graph.restore()
    }
  }
)
