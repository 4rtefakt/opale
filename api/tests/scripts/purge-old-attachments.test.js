// Couvre api/scripts/purge-old-attachments.js :
// - ticket closed ancien → PJ purgée (row supprimée)
// - ticket closed récent → PJ conservée
// - ticket open ancien → PJ conservée (seuls les closed sont purgés)
// - dryRun → rien supprimé

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { runPurge } from '../../scripts/purge-old-attachments.js'

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

// Crée un ticket + 1 PJ. status/updatedAgo paramétrables.
async function seedTicketWithAttachment(db, { status = 'closed', updatedAgo = '7 months' } = {}) {
  const { rows: t } = await db.query(
    `INSERT INTO tickets (title, status, updated_at)
     VALUES ('T', $1, now() - ($2)::interval) RETURNING id`,
    [status, updatedAgo]
  )
  const ticketId = t[0].id
  const { rows: a } = await db.query(`
    INSERT INTO ticket_attachments (ticket_id, filename, size_bytes, storage_path)
    VALUES ($1, 'f.txt', 10, $2) RETURNING id
  `, [ticketId, `${ticketId}/fake-uuid`])
  return { ticketId, attId: a[0].id }
}

async function attExists(db, attId) {
  const { rows } = await db.query(`SELECT 1 FROM ticket_attachments WHERE id = $1`, [attId])
  return rows.length > 0
}

test('runPurge : ticket fermé ancien → PJ purgée', { skip: SKIP }, async () => {
  const { attId } = await seedTicketWithAttachment(db, { status: 'closed', updatedAgo: '7 months' })
  const res = await runPurge(db, { log: quietLog })
  assert.ok(res.purged >= 1)
  assert.equal(await attExists(db, attId), false, 'la row PJ doit être supprimée')
})

test('runPurge : ticket fermé récent → PJ conservée', { skip: SKIP }, async () => {
  const { attId } = await seedTicketWithAttachment(db, { status: 'closed', updatedAgo: '1 month' })
  await runPurge(db, { log: quietLog })
  assert.equal(await attExists(db, attId), true, 'PJ récente conservée')
})

test('runPurge : ticket ouvert ancien → PJ conservée', { skip: SKIP }, async () => {
  const { attId } = await seedTicketWithAttachment(db, { status: 'open', updatedAgo: '12 months' })
  await runPurge(db, { log: quietLog })
  assert.equal(await attExists(db, attId), true, 'seuls les closed sont purgés')
})

test('runPurge : dryRun ne supprime rien', { skip: SKIP }, async () => {
  const { attId } = await seedTicketWithAttachment(db, { status: 'closed', updatedAgo: '8 months' })
  const res = await runPurge(db, { dryRun: true, log: quietLog })
  assert.ok(res.purged >= 1)
  assert.equal(await attExists(db, attId), true, 'dryRun ne doit pas DELETE')
})
