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

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { installFakeGraph, graphTime, fakeMail } from '../helpers/fake-graph-mail.js'
import { pollOnce } from '../../modules/email-bridge/lib/poll-worker.js'
import { _resetSystemFolderCache } from '../../modules/email-bridge/lib/graph-mail.js'

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
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

beforeEach(async () => {
  if (SKIP) return
  _resetSystemFolderCache()
  await db.query(`TRUNCATE TABLE email_thread_mapping CASCADE`)
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
