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
//     échecs ET MIN_POISON_AGE_MS, et seulement si le mail suivant passe :
//     la boîte n'est pas bloquée indéfiniment, mais une panne systémique
//     (le suivant échoue aussi) n'abandonne rien
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
import { MAX_INGEST_ATTEMPTS, MAX_SKIP_PAGES, MIN_POISON_AGE_MS } from '../../modules/email-bridge/lib/poll-cursor.js'

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
  await db.query(`DELETE FROM audit_logs WHERE action LIKE 'mail_ingest%'`)
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

async function cursorState() {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [`mail.cursor_state.${MAILBOX}`])
  return JSON.parse(rows[0].value)
}

// Horloge injectée (pollOnce(db, log, { now })) : l'âge d'un échec compte.
const TICK_MS = 5 * 60_000
function fakeClock(start = Date.parse('2026-05-10T10:00:00Z')) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}

async function failMappingInsertFor(mail) {
  await db.query(`INSERT INTO test_failing_mail VALUES ($1)`, [mail.internetMessageId])
}

async function blockedAudits() {
  const { rows } = await db.query(
    `SELECT target, details FROM audit_logs WHERE action = 'mail_ingest_blocked' ORDER BY created_at`
  )
  return rows
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

test('pollOnce : mail retiré de la plage entre deux pages d\'un tick → la page suivante n\'est pas décalée',
  { skip: SKIP }, async () => {
    // Page 1 : 45 exclus + 5 utiles (< 50 traités → le tick continue).
    // Entre la page 1 et la suivante, un mail de la page 1 quitte la plage
    // (suppression définitive, brouillon envoyé…). Un nextLink `$skip=50`
    // démarrerait alors un mail trop loin : le 1er mail de la page 2,
    // plus ancien que le nouveau curseur, serait perdu.
    const excluded = Array.from({ length: 45 }, (_, i) => fakeMail({
      receivedDateTime: at(i + 1), parentFolderId: 'sent-id',
    }))
    const useful = [
      ...Array.from({ length: 5 }, (_, i) => fakeMail({ receivedDateTime: at(46 + i) })),
      ...Array.from({ length: 10 }, (_, i) => fakeMail({ receivedDateTime: at(60 + i) })),
    ]
    useGraph({ inbox: [...excluded, ...useful] })
    let lists = 0
    graph.onList = () => {
      if (++lists === 2) graph.inbox.splice(graph.inbox.indexOf(excluded[3]), 1)
    }
    try {
      await pollOnce(db, null)
      await pollOnce(db, null)
      assert.deepEqual((await ingestedIds()).sort(), ids(useful).sort(), 'aucun mail sauté')
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

test('pollOnce : rafale de plus de 250 mails dans la même seconde → tous ingérés, boîte jamais bloquée',
  { skip: SKIP }, async () => {
    // Le listing inclusif relit à chaque tick les ex aequo déjà traités :
    // ces pages ne coûtent rien et ne comptent pas dans MAX_PAGES, sinon la
    // fenêtre du tick en serait remplie (et le garde-fou perdrait la fin).
    const burst = Array.from({ length: 260 }, () => fakeMail({ receivedDateTime: at(1) }))
    const later = fakeMail({ receivedDateTime: at(2) })
    useGraph({ inbox: [...burst, later] })
    const alerts = []
    const log = { info() {}, warn: (_o, msg) => alerts.push(msg), error: (_o, msg) => alerts.push(msg) }
    try {
      for (let tick = 0; tick < 8; tick++) await pollOnce(db, log)
      assert.deepEqual((await ingestedIds()).sort(), ids([...burst, later]).sort(), 'chaque mail de la rafale est ingéré')
      assert.deepEqual(alerts, [], 'aucun saut de seconde')
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : garde-fou (> MAX_SKIP_PAGES pages d\'ex aequo déjà traités) → erreur chiffrée, seconde suivante exacte',
  { skip: SKIP }, async () => {
    // Dernier recours, plus de 2000 mails dans la même seconde : état
    // pré-rempli comme après 40 ticks. Curseur à la milliseconde (cas d'un
    // curseur initialisé par now()) : la seconde suivante doit être 02.000,
    // pas 02.200 — sinon le mail de 09:00:02 serait sauté.
    const second = '2026-05-10T09:00:01.200Z'
    const ties = Array.from({ length: MAX_SKIP_PAGES * 50 + 10 }, () => fakeMail({ receivedDateTime: second }))
    // Deux exclus (Envoyés) dans la même seconde : pas comptés comme perdus.
    const excludedTies = Array.from({ length: 2 }, () => fakeMail({ receivedDateTime: second, parentFolderId: 'sent-id' }))
    const later = fakeMail({ receivedDateTime: at(2) })
    const handled = ties.slice(0, MAX_SKIP_PAGES * 50)
    await db.query(`UPDATE settings SET value = $1 WHERE key = $2`, [second, `mail.cursor.${MAILBOX}`])
    await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2)`, [
      `mail.cursor_state.${MAILBOX}`, JSON.stringify({ at: second, done: handled.map(m => m.id), retry: null }),
    ])
    useGraph({ inbox: [...ties, ...excludedTies, later] })
    const errors = []
    const log = { info() {}, warn() {}, error: (obj, msg) => errors.push({ obj, msg }) }
    try {
      await pollOnce(db, log)
      assert.equal(errors.length, 1, 'saut de seconde signalé en erreur')
      assert.equal(errors[0].obj.already_handled, handled.length)
      assert.equal(errors[0].obj.not_ingested, 10, 'mails perdus décomptés (exclus non comptés)')
      assert.match(errors[0].msg, /PAS ingérés/)
      assert.equal(await cursorMs(), Date.parse(at(2)), 'seconde suivante exacte (millisecondes du curseur ignorées)')

      // Visible dans l'interface : une ligne d'audit niveau error.
      const { rows } = await db.query(
        `SELECT target, details FROM audit_logs WHERE action = 'mail_ingest_second_skipped'`)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].target, MAILBOX)
      assert.deepEqual(rows[0].details, {
        level: 'error', worker: 'email-bridge', cursor: second, next_cursor: new Date(Date.parse(at(2))).toISOString(),
        already_handled: handled.length, not_ingested: 10, not_ingested_exact: true,
      })

      await pollOnce(db, log)
      assert.ok((await ingestedIds()).includes(later.internetMessageId))
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
      assert.equal((await cursorState()).retry, null, 'compteur d\'échecs effacé une fois le mail traité')
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : mail retenté → classifieur (LLM) appelé une seule fois, résultat mémorisé entre les reprises',
  { skip: SKIP }, async () => {
    const setClassifier = enabled => db.query(`
      UPDATE settings SET value = CASE key
        WHEN 'mail.classifier.enabled' THEN $1
        WHEN 'mail.classifier.url'     THEN $2
        WHEN 'mail.classifier.model'   THEN $3 END
      WHERE key IN ('mail.classifier.enabled', 'mail.classifier.url', 'mail.classifier.model')
    `, enabled ? ['true', 'http://stub', 'stub-model'] : ['false', '', ''])
    await setClassifier(true)
    const mail = fakeMail({ receivedDateTime: at(1) })
    useGraph({ inbox: [mail] })
    await failMappingInsertFor(mail)
    let calls = 0
    const classifierFn = async () => { calls++; return { intent: 'new_ticket', confidence: 0.8, reason: 'stub' } }
    try {
      for (let tick = 0; tick < 3; tick++) await pollOnce(db, null, { classifierFn })
      await db.query(`TRUNCATE TABLE test_failing_mail`)
      await pollOnce(db, null, { classifierFn })

      assert.deepEqual(await ingestedIds(), ids([mail]))
      assert.equal(calls, 1, 'une seule classification pour 4 tentatives')
      const { rows } = await db.query(
        `SELECT classifier_result FROM email_thread_mapping WHERE internet_message_id = $1`, [mail.internetMessageId])
      assert.equal(rows[0].classifier_result.intent, 'new_ticket', 'résultat mémorisé réutilisé')
    } finally {
      graph.restore()
      await setClassifier(false)
    }
  }
)

test('pollOnce : mail « poison » → abandonné après MAX_INGEST_ATTEMPTS échecs ET MIN_POISON_AGE_MS, le mail suivant passant',
  { skip: SKIP }, async () => {
    const poison = fakeMail({ receivedDateTime: at(1) })
    const next = fakeMail({ receivedDateTime: at(2) })
    useGraph({ inbox: [poison, next] })
    await failMappingInsertFor(poison)
    const clock = fakeClock()
    try {
      // Un tick toutes les 5 min : MAX_INGEST_ATTEMPTS est atteint bien
      // avant l'âge minimal — le nombre de tentatives seul ne suffit plus.
      const ticksBeforeAge = MIN_POISON_AGE_MS / TICK_MS
      assert.ok(ticksBeforeAge > MAX_INGEST_ATTEMPTS)
      for (let tick = 1; tick <= ticksBeforeAge; tick++) {
        await pollOnce(db, null, { now: clock.now })
        clock.advance(TICK_MS)
        assert.equal(await cursorMs(), Date.parse(T0), `tick ${tick} : curseur pas avancé au-delà du mail en échec`)
        assert.ok(!(await ingestedIds()).includes(poison.internetMessageId))
      }
      assert.equal((await abandonedAudits()).length, 0, 'pas d\'abandon avant l\'âge minimal')

      const stats = await pollOnce(db, null, { now: clock.now })
      assert.equal(stats.abandoned, 1)
      const audits = await abandonedAudits()
      assert.equal(audits.length, 1)
      assert.equal(audits[0].target, MAILBOX)
      assert.equal(audits[0].by_user, 'system')
      assert.equal(audits[0].details.internet_message_id, poison.internetMessageId)
      assert.equal(audits[0].details.attempts, ticksBeforeAge + 1)
      assert.equal(audits[0].details.level, 'error', 'mail perdu : niveau error dans le journal')
      assert.match(audits[0].details.error, /échec simulé/)

      assert.deepEqual(await ingestedIds(), ids([next]), 'la boîte n\'est plus bloquée')
      assert.equal(await cursorMs(), Date.parse(at(2)))

      // Abandon définitif : plus retenté ensuite.
      await pollOnce(db, null, { now: clock.now })
      assert.equal((await abandonedAudits()).length, 1)
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : panne systémique (tous les mails échouent, settings OK) → aucun abandon, erreur à chaque tick, tout ingéré au rétablissement',
  { skip: SKIP }, async () => {
    // Pool saturé, statement_timeout, trigger ou contrainte cassés… : le
    // mail suivant échoue aussi → la panne n'est pas propre au mail, on
    // n'abandonne rien (avant : un mail abandonné toutes les ~2 min 30).
    const mails = Array.from({ length: 6 }, (_, i) => fakeMail({ receivedDateTime: at(i + 1) }))
    useGraph({ inbox: mails })
    for (const m of mails) await failMappingInsertFor(m)
    const clock = fakeClock()
    const errors = []
    const log = { info() {}, warn() {}, error: (_o, msg) => errors.push(msg) }
    try {
      const ticks = (3 * 3600_000) / TICK_MS   // 3 h de panne
      let abandoned = 0
      for (let tick = 0; tick < ticks; tick++) {
        abandoned += (await pollOnce(db, log, { now: clock.now })).abandoned
        clock.advance(TICK_MS)
      }
      assert.equal(abandoned, 0)
      assert.equal((await abandonedAudits()).length, 0)
      assert.equal(await cursorMs(), Date.parse(T0))
      const systemic = errors.filter(m => /systémique/.test(m)).length
      assert.equal(systemic, ticks - MIN_POISON_AGE_MS / TICK_MS, 'une erreur par tick une fois l\'âge minimal atteint')

      // Blocage visible : UNE ligne d'audit, pas une par tick.
      const blocked = await blockedAudits()
      assert.equal(blocked.length, 1)
      assert.equal(blocked[0].target, MAILBOX)
      const d = blocked[0].details
      assert.equal(d.level, 'error')
      assert.equal(d.internet_message_id, mails[0].internetMessageId)
      assert.equal(d.since, new Date(Date.parse('2026-05-10T10:00:00Z')).toISOString())
      assert.equal(d.attempts, MIN_POISON_AGE_MS / TICK_MS + 1)
      assert.match(d.error, /échec simulé/)
      assert.match(d.next_error, /échec simulé/)
      assert.match(d.recovery_sql, new RegExp(`UPDATE settings SET value = '[^']+' WHERE key = 'mail\\.cursor\\.${MAILBOX.replace('.', '\\.')}';`))
      assert.match(d.log, /aucun mail abandonné/)

      await db.query(`TRUNCATE TABLE test_failing_mail`)
      await pollOnce(db, log, { now: clock.now })
      assert.deepEqual(await ingestedIds(), ids(mails), 'tout est ingéré au rétablissement')
      assert.equal((await cursorState()).retry, null, 'boîte repartie : alerte réarmée')

      // Nouvelle panne plus tard : nouvelle (et unique) alerte.
      const later = Array.from({ length: 2 }, (_, i) => fakeMail({ receivedDateTime: at(100 + i) }))
      graph.inbox.push(...later)
      for (const m of later) await failMappingInsertFor(m)
      for (let tick = 0; tick < 12; tick++) {
        await pollOnce(db, log, { now: clock.now })
        clock.advance(TICK_MS)
      }
      assert.equal((await blockedAudits()).length, 2)
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : boîte bloquée par deux mails poison consécutifs → le SQL de reprise de l\'audit la débloque',
  { skip: SKIP }, async () => {
    // Limite assumée du coupe-circuit : indiscernable d'une panne
    // systémique. Le SQL fourni par l'audit passe le premier mail ; le
    // second est ensuite abandonné normalement (le mail suivant écrit).
    const p1 = fakeMail({ receivedDateTime: at(1) })
    const p2 = fakeMail({ receivedDateTime: at(2) })
    const good = fakeMail({ receivedDateTime: at(3) })
    useGraph({ inbox: [p1, p2, good] })
    await failMappingInsertFor(p1)
    await failMappingInsertFor(p2)
    const clock = fakeClock()
    try {
      for (let tick = 0; tick < 8; tick++) {
        await pollOnce(db, null, { now: clock.now })
        clock.advance(TICK_MS)
      }
      const [alert] = await blockedAudits()
      assert.ok(alert, 'blocage signalé')
      assert.deepEqual(await ingestedIds(), [])

      await db.query(alert.details.recovery_sql)
      for (let tick = 0; tick < 8; tick++) {
        await pollOnce(db, null, { now: clock.now })
        clock.advance(TICK_MS)
      }
      const abandoned = await abandonedAudits()
      assert.deepEqual(abandoned.map(a => a.details.internet_message_id), [p2.internetMessageId])
      assert.deepEqual(await ingestedIds(), ids([good]))
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : suspect à la seconde du curseur, retour arrière (panne systémique) → le suspect n\'est pas sauté',
  { skip: SKIP }, async () => {
    // x et le suspect partagent la seconde du curseur : le retour arrière
    // doit restaurer `done` tel qu'avant le suspect (copie), sinon le
    // suspect y reste et est ensuite écarté comme « déjà traité ».
    const x = fakeMail({ receivedDateTime: at(1) })
    const suspect = fakeMail({ receivedDateTime: at(1) })
    const next = fakeMail({ receivedDateTime: at(2) })
    useGraph({ inbox: [x, suspect, next] })
    await failMappingInsertFor(suspect)
    await failMappingInsertFor(next)
    const clock = fakeClock()
    try {
      for (let tick = 0; tick < 8; tick++) {   // 40 min : la branche systémique joue
        await pollOnce(db, null, { now: clock.now })
        clock.advance(TICK_MS)
      }
      assert.equal((await cursorState()).done.includes(suspect.id), false, 'suspect absent de done après retour arrière')

      await db.query(`TRUNCATE TABLE test_failing_mail`)
      await pollOnce(db, null, { now: clock.now })
      assert.deepEqual((await ingestedIds()).sort(), ids([x, suspect, next]).sort(), 'rien perdu')
      assert.equal((await abandonedAudits()).length, 0)
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : panne systémique, mail suivant déjà ingéré (rien d\'écrit) → pas de verdict, aucun abandon',
  { skip: SKIP }, async () => {
    // Copie d'un mail déjà ingéré (règle « copier vers un dossier ») :
    // already_ingested n'écrit rien et ne prouve pas que l'écriture marche.
    await db.query(`
      INSERT INTO email_thread_mapping (internet_message_id, mailbox, direction, received_at)
      VALUES ('<deja-ingere@example.com>', $1, 'inbound', now())
    `, [MAILBOX])
    const suspect = fakeMail({ receivedDateTime: at(1) })
    const copy = fakeMail({ receivedDateTime: at(2), internetMessageId: '<deja-ingere@example.com>' })
    const next = fakeMail({ receivedDateTime: at(3) })
    useGraph({ inbox: [suspect, copy, next] })
    await failMappingInsertFor(suspect)
    await failMappingInsertFor(next)
    const clock = fakeClock()
    try {
      let abandoned = 0
      for (let tick = 0; tick < 12; tick++) {   // 1 h
        abandoned += (await pollOnce(db, null, { now: clock.now })).abandoned
        clock.advance(TICK_MS)
      }
      assert.equal(abandoned, 0)
      assert.equal((await abandonedAudits()).length, 0)

      await db.query(`TRUNCATE TABLE test_failing_mail`)
      await pollOnce(db, null, { now: clock.now })
      for (const m of [suspect, next]) {
        assert.ok((await ingestedIds()).includes(m.internetMessageId), 'rattrapé au rétablissement')
      }
    } finally {
      graph.restore()
    }
  }
)

test('pollOnce : mail en échec sans mail suivant → pas abandonné (rien à débloquer), abandonné dès qu\'un mail suivant passe',
  { skip: SKIP }, async () => {
    const poison = fakeMail({ receivedDateTime: at(1) })
    useGraph({ inbox: [poison] })
    await failMappingInsertFor(poison)
    const clock = fakeClock()
    try {
      for (let tick = 0; tick < (2 * 3600_000) / TICK_MS; tick++) {
        await pollOnce(db, null, { now: clock.now })
        clock.advance(TICK_MS)
      }
      assert.equal((await abandonedAudits()).length, 0)
      assert.equal(await cursorMs(), Date.parse(T0))

      const next = fakeMail({ receivedDateTime: at(2) })
      graph.inbox.push(next)
      await pollOnce(db, null, { now: clock.now })
      assert.equal((await abandonedAudits()).length, 1)
      assert.deepEqual(await ingestedIds(), ids([next]))
    } finally {
      graph.restore()
    }
  }
)
