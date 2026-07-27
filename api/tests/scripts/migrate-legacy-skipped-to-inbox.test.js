// Couvre api/scripts/migrate-legacy-skipped-to-inbox.js :
// - happy : skipped_other → pending_review, classifier re-appelé en advisory
// - mapping déjà lié à un ticket → ignoré
// - mapping pending_review → ignoré (idempotence)
// - mode --check (dryRun) : pas d'UPDATE
// - classifier désactivé → re-inject sans re-classify

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { runMigration } from '../../scripts/migrate-legacy-skipped-to-inbox.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release
const quietLog = { log: () => {}, warn: () => {}, error: () => {} }

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

async function seedMapping(db, {
  action = 'skipped_other',
  ticketId = null,
  fromAddress = 'newsletter@ex.fr',
  subject = 'Newsletter',
  bodyPreview = '<p>Newsletter HTML</p>',
  classifierResult = { intent: 'other', confidence: 0.95 },
} = {}) {
  const internetMessageId = `<legacy-${Math.random().toString(36).slice(2)}@x>`
  const raw = {
    id: `graph-${Math.random().toString(36).slice(2)}`,
    internetMessageId, from: { emailAddress: { address: fromAddress } },
    subject, bodyPreview,
  }
  const { rows } = await db.query(`
    INSERT INTO email_thread_mapping
      (internet_message_id, mailbox, direction, from_address, subject,
       received_at, raw, action, ticket_id, processed_at, classifier_result)
    VALUES ($1, 'helpdesk@test', 'inbound', $2, $3, now(), $4, $5, $6, now(), $7)
    RETURNING id
  `, [internetMessageId, fromAddress, subject, JSON.stringify(raw), action,
      ticketId, JSON.stringify(classifierResult)])
  return rows[0].id
}

test('runMigration : skipped_other sans ticket → pending_review + re-classify advisory',
  { skip: SKIP }, async () => {
    const id1 = await seedMapping(db, { subject: 'Newsletter 1' })
    const id2 = await seedMapping(db, { subject: 'Newsletter 2' })

    // Stub classifier qui retourne un nouveau verdict
    let callCount = 0
    const stub = async () => { callCount++; return { intent: 'new_ticket', confidence: 0.6, reason: 'stub re-classify' } }

    const res = await runMigration(db, { log: quietLog, classifierFn: stub })
    assert.equal(res.migrated, 2)
    assert.equal(res.reclassified, 2)
    assert.equal(callCount, 2)

    const { rows } = await db.query(
      `SELECT action, classifier_result FROM email_thread_mapping WHERE id IN ($1, $2) ORDER BY subject`,
      [id1, id2]
    )
    for (const r of rows) {
      assert.equal(r.action, 'pending_review')
      assert.equal(r.classifier_result.intent, 'new_ticket')
      assert.equal(r.classifier_result.reason, 'stub re-classify')
      assert.ok(r.classifier_result.reclassified_at, 'reclassified_at posé')
    }
  }
)

test('runMigration : mapping déjà lié à un ticket → ignoré',
  { skip: SKIP }, async () => {
    const { rows: tk } = await db.query(`INSERT INTO tickets (title) VALUES ('T') RETURNING id`)
    // Edge case mal modélisé en théorie (skipped_other + ticket_id NOT NULL),
    // mais on vérifie quand même le garde-fou WHERE ticket_id IS NULL.
    const id = await seedMapping(db, { ticketId: tk[0].id, action: 'skipped_other' })

    const stub = async () => ({ intent: 'new_ticket', confidence: 0.5 })
    const res = await runMigration(db, { log: quietLog, classifierFn: stub })

    const { rows } = await db.query(`SELECT action FROM email_thread_mapping WHERE id = $1`, [id])
    assert.equal(rows[0].action, 'skipped_other', 'non touché car ticket_id NOT NULL')
    assert.ok(!res.migrated || res.migrated === 0)
  }
)

test('runMigration : mapping pending_review → ignoré (idempotence après re-run)',
  { skip: SKIP }, async () => {
    const id = await seedMapping(db, { action: 'pending_review' })
    const stub = async () => ({ intent: 'other', confidence: 0.9 })
    await runMigration(db, { log: quietLog, classifierFn: stub })

    // Le mapping ne devrait pas être compté (filtre WHERE action='skipped_other')
    const { rows } = await db.query(`SELECT action FROM email_thread_mapping WHERE id = $1`, [id])
    assert.equal(rows[0].action, 'pending_review')
  }
)

test('runMigration : dryRun ne modifie rien',
  { skip: SKIP }, async () => {
    const id = await seedMapping(db, { subject: 'Dry-run check' })
    const stub = async () => ({ intent: 'new_ticket', confidence: 0.7 })
    const res = await runMigration(db, { dryRun: true, log: quietLog, classifierFn: stub })
    assert.ok(res.migrated >= 1)

    const { rows } = await db.query(`SELECT action FROM email_thread_mapping WHERE id = $1`, [id])
    assert.equal(rows[0].action, 'skipped_other', 'dryRun ne doit pas UPDATE')
  }
)

test('runMigration : classifier non configuré → re-inject sans re-classify',
  { skip: SKIP }, async () => {
    // Désactive le classifier
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'mail.classifier.enabled'`)
    const originalClassifier = { intent: 'other', confidence: 0.95, original: true }
    const id = await seedMapping(db, { classifierResult: originalClassifier })

    // PAS de classifierFn → tombe sur getClassifierConfig qui retourne null
    const res = await runMigration(db, { log: quietLog })
    assert.equal(res.reclassified, 0, 'pas de re-classify')

    const { rows } = await db.query(`SELECT action, classifier_result FROM email_thread_mapping WHERE id = $1`, [id])
    assert.equal(rows[0].action, 'pending_review', 're-injecté quand même')
    assert.equal(rows[0].classifier_result.original, true, 'classifier_result historique conservé')
  }
)

test('runMigration : classifier échoue → mapping re-injecté quand même, classifier_result inchangé',
  { skip: SKIP }, async () => {
    const originalClassifier = { intent: 'other', confidence: 0.8, kept: true }
    const id = await seedMapping(db, { classifierResult: originalClassifier })
    const failingStub = async () => { throw new Error('Ollama timeout') }
    const res = await runMigration(db, { log: quietLog, classifierFn: failingStub })

    assert.ok(res.failed >= 1)
    const { rows } = await db.query(`SELECT action, classifier_result FROM email_thread_mapping WHERE id = $1`, [id])
    assert.equal(rows[0].action, 'pending_review', 're-injecté malgré l\'échec classify')
    assert.equal(rows[0].classifier_result.kept, true, 'classifier_result original conservé')
  }
)
