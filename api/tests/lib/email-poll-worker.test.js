// Tests d'intégration du worker de polling inbound (pollOnce) : curseur,
// pagination Graph et reprise. Graph est simulé au niveau fetch()
// (helpers/fake-graph-mail.js) : le vrai listMessagesSince (URL, filtrage
// des dossiers système, nextLink) est exercé, sans aucun appel réseau.
//
// Chemins critiques :
//   - page 1 entièrement exclue (Envoyés…) + nextLink → le mail de la page 2
//     est ingéré, le curseur avance (il restait bloqué sur la page 1)
//   - pagination bornée par tick : reprise au tick suivant
//   - horodatages égaux à la coupure de page / mail visible plus tard au
//     même horodatage que le curseur → pas sautés (filtre `ge` + ids traités)
//   - transaction en échec sur un mail → curseur arrêté avant lui, retenté
//     au tick suivant sans retraiter les mails déjà ingérés
//   - mail « poison » → abandonné (log + audit) après MAX_INGEST_ATTEMPTS
//     échecs, la boîte n'est pas bloquée indéfiniment
//
// Les échecs de transaction sont provoqués par un trigger de test sur
// email_thread_mapping (INSERT refusé pour les internet_message_id listés
// dans test_failing_mail) : même chemin que prod (ROLLBACK dans processOne).

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { installFakeGraph, graphTime, fakeMail } from '../helpers/fake-graph-mail.js'
import { pollOnce } from '../../modules/email-bridge/lib/poll-worker.js'
import { _resetSystemFolderCache } from '../../modules/email-bridge/lib/graph-mail.js'
import { MAX_INGEST_ATTEMPTS } from '../../modules/email-bridge/lib/poll-cursor.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip poll-worker suite'

const MAILBOX = 'helpdesk@example.com'
const T0 = '2026-05-10T09:00:00.000Z'
const at = s => graphTime(T0, s)
const FOLDERS = { sentitems: 'sent-id', drafts: 'drafts-id', deleteditems: 'deleted-id', junkemail: 'junk-id' }

let db, release, graph

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  await db.query(`UPDATE settings SET value = 'true' WHERE key = 'mail.poll_enabled'`)
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'mail.inboxes'`, [MAILBOX])

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
  _resetSystemFolderCache()
  await db.query(`TRUNCATE TABLE email_thread_mapping CASCADE`)
  await db.query(`TRUNCATE TABLE test_failing_mail`)
  await db.query(`DELETE FROM audit_logs WHERE action = 'mail_ingest_abandoned'`)
  await db.query(`DELETE FROM settings WHERE key LIKE 'mail.cursor%'`)
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)`,
    [`mail.cursor.${MAILBOX}`, T0]
  )
})

function useGraph(opts) {
  graph = installFakeGraph({ folders: FOLDERS, ...opts })
  return graph
}

async function ingestedIds() {
  const { rows } = await db.query(
    `SELECT internet_message_id FROM email_thread_mapping ORDER BY received_at, internet_message_id`
  )
  return rows.map(r => r.internet_message_id)
}

async function cursorMs() {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [`mail.cursor.${MAILBOX}`])
  return Date.parse(rows[0].value)
}

const ids = mails => mails.map(m => m.internetMessageId)

async function failMappingInsertFor(mail) {
  await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [mail.internetMessageId])
}

async function abandonedAudits() {
  const { rows } = await db.query(
    `SELECT by_user, target, details FROM audit_logs WHERE action = 'mail_ingest_abandoned'`
  )
  return rows
}

test('pollOnce : page 1 entièrement exclue + nextLink → mail de la page 2 ingéré, curseur avancé',
  { skip: SKIP }, async () => {
    // 50 mails des dossiers système (= $top) remplissent toute la page 1 :
    // après filtrage, `value` est vide. Le mail utile est en page 2.
    const excluded = Array.from({ length: 50 }, (_, i) => fakeMail({
      receivedDateTime: at(i + 1),
      parentFolderId: ['sent-id', 'junk-id', 'deleted-id'][i % 3],
    }))
    const wanted = fakeMail({ receivedDateTime: at(60) })
    useGraph({ inbox: [...excluded, wanted] })
    try {
      await pollOnce(db, null)
      assert.deepEqual(await ingestedIds(), ids([wanted]), 'le mail de la page 2 doit être ingéré')
      assert.equal(await cursorMs(), Date.parse(at(60)), 'curseur avancé au-delà des mails exclus')
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : pagination bornée par tick, le curseur avance sur les exclus et reprend au tick suivant',
  { skip: SKIP }, async () => {
    // 300 mails exclus (6 pages) puis un mail utile : un tick ne lit pas
    // toute la boîte, mais sa progression sur les exclus est conservée.
    const excluded = Array.from({ length: 300 }, (_, i) => fakeMail({
      receivedDateTime: at(i + 1), parentFolderId: 'sent-id',
    }))
    const wanted = fakeMail({ receivedDateTime: at(400) })
    useGraph({ inbox: [...excluded, wanted] })
    try {
      await pollOnce(db, null)
      const firstTickListCalls = graph.listCalls().length
      assert.ok(firstTickListCalls >= 2 && firstTickListCalls <= 5,
        `pages suivies mais bornées par tick (${firstTickListCalls} requêtes)`)
      assert.deepEqual(await ingestedIds(), [])
      assert.ok(await cursorMs() > Date.parse(T0), 'progression sur les exclus conservée')

      await pollOnce(db, null)
      assert.deepEqual(await ingestedIds(), ids([wanted]))
      assert.equal(await cursorMs(), Date.parse(at(400)))
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : horodatages égaux de part et d\'autre d\'une coupure de page → aucun mail sauté',
  { skip: SKIP }, async () => {
    // 49 mails, puis deux mails à la MÊME seconde : le 50e ferme la page 1
    // ($top=50), le 51e ouvre la page 2. Un curseur `gt` posé sur le 50e
    // sautait le 51e.
    const mails = Array.from({ length: 49 }, (_, i) => fakeMail({ receivedDateTime: at(i + 1) }))
    const tieA = fakeMail({ receivedDateTime: at(50) })
    const tieB = fakeMail({ receivedDateTime: at(50) })
    useGraph({ inbox: [...mails, tieA, tieB] })
    try {
      await pollOnce(db, null)
      await pollOnce(db, null)
      assert.deepEqual((await ingestedIds()).sort(), ids([...mails, tieA, tieB]).sort())
      assert.equal(await cursorMs(), Date.parse(at(50)))
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : mail visible plus tard au même horodatage que le curseur → ingéré, sans rejouer le précédent',
  { skip: SKIP }, async () => {
    const first = fakeMail({ receivedDateTime: at(5) })
    useGraph({ inbox: [first] })
    try {
      await pollOnce(db, null)
      assert.deepEqual(await ingestedIds(), ids([first]))

      // Même seconde que le curseur, apparu après le premier tick.
      const late = fakeMail({ receivedDateTime: at(5) })
      graph.inbox.push(late)
      const stats = await pollOnce(db, null)
      assert.deepEqual((await ingestedIds()).sort(), ids([first, late]).sort())
      assert.equal(stats.actions.already_ingested, 0,
        'le mail déjà traité au même horodatage est écarté sans être retraité')
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : rafale de plus de 250 mails dans la même seconde → la boîte n\'est jamais bloquée (warn)',
  { skip: SKIP }, async () => {
    // Cas dégénéré : le listing inclusif renverrait toujours les mêmes 5
    // pages (déjà traitées). Garde-fou : on passe la seconde, en le signalant.
    const burst = Array.from({ length: 260 }, () => fakeMail({ receivedDateTime: at(1) }))
    const later = fakeMail({ receivedDateTime: at(2) })
    useGraph({ inbox: [...burst, later] })
    const warns = []
    const log = { info() {}, error() {}, warn: (_obj, msg) => warns.push(msg) }
    try {
      for (let tick = 0; tick < 10 && !(await ingestedIds()).includes(later.internetMessageId); tick++) {
        await pollOnce(db, log)
      }
      assert.ok((await ingestedIds()).includes(later.internetMessageId), 'le mail suivant finit par être ingéré')
      assert.ok(warns.some(m => /même horodatage/.test(m)), 'saut de seconde signalé')
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : transaction en échec sur un mail → curseur arrêté avant lui, retenté au tick suivant sans doublon',
  { skip: SKIP }, async () => {
    const a = fakeMail({ receivedDateTime: at(1) })
    const b = fakeMail({ receivedDateTime: at(2) })
    const c = fakeMail({ receivedDateTime: at(3) })
    useGraph({ inbox: [a, b, c] })
    await failMappingInsertFor(b)
    try {
      const first = await pollOnce(db, null)
      assert.equal(first.actions.skipped_error, 1, 'processOne a bien échoué sur b (ROLLBACK)')
      assert.ok(!(await ingestedIds()).includes(b.internetMessageId))
      assert.equal(await cursorMs(), Date.parse(at(1)), 'curseur arrêté juste avant le mail en échec')

      // La cause de l'échec disparaît : b est retenté, a n'est pas retraité.
      await db.query(`TRUNCATE TABLE test_failing_mail`)
      const second = await pollOnce(db, null)
      assert.deepEqual(await ingestedIds(), ids([a, b, c]))
      assert.equal(second.actions.already_ingested, 0, 'les mails déjà ingérés ne sont pas rejoués')
      assert.equal(await cursorMs(), Date.parse(at(3)))
      assert.equal((await abandonedAudits()).length, 0)
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : mail « poison » → abandonné (audit) après MAX_INGEST_ATTEMPTS échecs, la boîte repart',
  { skip: SKIP }, async () => {
    const poison = fakeMail({ receivedDateTime: at(1) })
    const next = fakeMail({ receivedDateTime: at(2) })
    useGraph({ inbox: [poison, next] })
    await failMappingInsertFor(poison)
    try {
      for (let attempt = 1; attempt < MAX_INGEST_ATTEMPTS; attempt++) {
        await pollOnce(db, null)
        assert.equal(await cursorMs(), Date.parse(T0),
          `tentative ${attempt} : curseur pas avancé au-delà du mail en échec`)
        assert.ok(!(await ingestedIds()).includes(poison.internetMessageId))
      }
      assert.equal((await abandonedAudits()).length, 0, 'pas d\'abandon avant la dernière tentative')

      const stats = await pollOnce(db, null)
      assert.equal(stats.abandoned, 1)
      const audits = await abandonedAudits()
      assert.equal(audits.length, 1)
      assert.equal(audits[0].target, MAILBOX)
      assert.equal(audits[0].by_user, 'system')
      assert.equal(audits[0].details.internet_message_id, poison.internetMessageId)
      assert.equal(audits[0].details.attempts, MAX_INGEST_ATTEMPTS)
      assert.match(audits[0].details.error, /échec simulé/)

      assert.deepEqual(await ingestedIds(), ids([next]), 'la boîte n\'est plus bloquée')
      assert.equal(await cursorMs(), Date.parse(at(2)))

      // Abandon définitif : plus retenté ensuite.
      await pollOnce(db, null)
      assert.equal((await abandonedAudits()).length, 1)
    } finally {
      graph.restore()
    }
  }
)
