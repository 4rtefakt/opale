import { test } from 'node:test'
import assert from 'node:assert/strict'

import { logAudit, insertAudit } from '../../modules/core/lib/audit.js'

// ── Helpers de mock ────────────────────────────────────────────────────────

function makeDb(opts = {}) {
  const calls = []
  const query = opts.rejects
    ? async (...args) => { calls.push(args); throw new Error(opts.rejects) }
    : async (...args) => { calls.push(args) }
  return { query, calls }
}

function makeLog() {
  const warns = []
  return { warn: (...args) => warns.push(args), warns }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('INSERT correct quand tous les champs sont fournis', async () => {
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, {
    action:  'test_action',
    byUser:  'admin@example.com',
    target:  'device-uuid-123',
    details: { foo: 'bar' },
  })

  assert.equal(db.calls.length, 1)
  const [sql, params] = db.calls[0]
  assert.match(sql, /INSERT INTO audit_logs/)
  assert.equal(params[0], 'test_action')
  assert.equal(params[1], 'admin@example.com')
  assert.equal(params[2], 'device-uuid-123')
  assert.equal(params[3], JSON.stringify({ foo: 'bar' }))
  assert.equal(log.warns.length, 0)
})

test('byUser, target, details à null si absents', async () => {
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, { action: 'foo' })

  assert.equal(db.calls.length, 1)
  const [, params] = db.calls[0]
  assert.equal(params[0], 'foo')
  assert.equal(params[1], null)
  assert.equal(params[2], null)
  assert.equal(params[3], null)
})

test('details JSON-stringify automatique', async () => {
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, { action: 'evt', details: { foo: 'bar' } })

  const [, params] = db.calls[0]
  assert.equal(params[3], '{"foo":"bar"}')
})

test('details null → null (pas de double-stringify)', async () => {
  // Le helper exige un objet et stringify systématiquement.
  // null details → null en DB (pas de stringify).
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, { action: 'evt', details: null })

  const [, params] = db.calls[0]
  assert.equal(params[3], null)
})

test('action manquant → warn + skip INSERT', async () => {
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, { action: null })

  assert.equal(db.calls.length, 0)
  assert.equal(log.warns.length, 1)
  assert.deepEqual(log.warns[0][0], { action: null })
  assert.match(log.warns[0][1], /action invalide/)
})

test('action manquant (undefined) → warn + skip INSERT', async () => {
  const db  = makeDb()
  const log = makeLog()
  await logAudit(db, log, {})

  assert.equal(db.calls.length, 0)
  assert.equal(log.warns.length, 1)
})

test('db.query rejette → warn + ne throw pas', async () => {
  const db  = makeDb({ rejects: 'connection lost' })
  const log = makeLog()

  // Ne doit pas throw
  await assert.doesNotReject(() =>
    logAudit(db, log, { action: 'test_action' })
  )

  assert.equal(db.calls.length, 1)
  assert.equal(log.warns.length, 1)
  assert.equal(log.warns[0][0].err, 'connection lost')
  assert.equal(log.warns[0][0].action, 'test_action')
})

test('log undefined → silent (aucune throw)', async () => {
  const db = makeDb({ rejects: 'boom' })

  // Ni log.warn dispo ni throw attendu
  await assert.doesNotReject(() =>
    logAudit(db, undefined, { action: 'test_action' })
  )
})

// ── insertAudit (variante fail-closed) ─────────────────────────────────────

test('insertAudit — même INSERT sur le client fourni, details stringifiés, null si absents', async () => {
  const client = makeDb()
  const details = { reason: { category: 'audit', note: 'vérification' }, outcome: 'ok' }
  await insertAudit(client, { action: 'laps_viewed', byUser: 'a@b', target: 'dev-1', details })
  await insertAudit(client, { action: 'laps_viewed' })

  assert.equal(client.calls.length, 2)
  assert.match(client.calls[0][0], /INSERT INTO audit_logs/)
  assert.deepEqual(client.calls[0][1], ['laps_viewed', 'a@b', 'dev-1', JSON.stringify(details)])
  assert.deepEqual(client.calls[1][1], ['laps_viewed', null, null, null])
})

test('insertAudit — l’erreur d’écriture remonte (contrairement à logAudit)', async () => {
  const client = makeDb({ rejects: 'audit refusé' })
  await assert.rejects(() => insertAudit(client, { action: 'laps_viewed' }), /audit refusé/)
})
