// lib/reports.js : matrice des transitions, règles du journal (NUL retirés,
// tailles bornées, aucun journal sur success / skipped), écriture
// transactionnelle (rapport append-only, last_* du poste, last_successful_revision
// sur succès seul, audit sur transition seule) et historique paginé.
// Schéma Postgres réel.

import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import {
  applyTransition, sanitizeReport, recordReport, listReports, alertApplyFailure, ERROR_SUMMARY_MAX, LOG_TAIL_MAX_BYTES,
} from '../../modules/linux/lib/reports.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)
const FP = 'f'.repeat(64)

let db, release
const log = null

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

const pullDevice = serial => seedDevice(db, { hostname: `lx-${serial.toLowerCase()}`, serial, platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
const send = (device, body) => recordReport(db, log, {
  deviceId: device.id, fingerprint: FP,
  body: { revision: SHA('1'), status: 'success', started_at: '2026-09-30T20:00:05Z', finished_at: '2026-09-30T20:00:41Z', ...body },
})

async function state(id) {
  const { rows: [row] } = await db.query('SELECT last_revision_applied, last_successful_revision, last_apply_status, last_apply_at FROM devices WHERE id = $1', [id])
  return row
}

async function audits(id) {
  const { rows } = await db.query("SELECT action, by_user, details FROM audit_logs WHERE target = $1 AND action LIKE 'linux_apply_%' ORDER BY created_at, id", [id])
  return rows
}

test('applyTransition : passage en échec depuis un état sain ou inconnu, rétablissement depuis un échec, rien sinon', () => {
  const cases = [
    [null, 'failed', 'failed'], [null, 'partial', 'failed'], [null, 'success', null], [null, 'skipped', null],
    ['failed', 'failed', null], ['partial', 'failed', null], ['failed', 'partial', null],
    ['failed', 'success', 'recovered'], ['partial', 'skipped', 'recovered'],
    ['success', 'skipped', null], ['skipped', 'success', null], ['success', 'success', null],
    ['success', 'failed', 'failed'], ['skipped', 'failed', 'failed'], ['success', 'partial', 'failed'],
  ]
  for (const [previous, status, expected] of cases) assert.equal(applyTransition(previous, status), expected, `${previous} → ${status}`)
})

test('sanitizeReport : journal conservé pour failed / partial seulement, NUL retirés, résumé, journal et version bornés', () => {
  const base = { revision: SHA('a'), status: 'failed', started_at: '2026-09-30T20:00:05Z', finished_at: '2026-09-30T20:00:41Z' }
  const failed = sanitizeReport({ ...base, error_summary: 'e\u0000rr'.repeat(600), log_tail: 'head\u0000' + 'x'.repeat(20_000) + 'tail', agent_version: 'v'.repeat(60) })
  assert.equal(failed.error_summary.length, ERROR_SUMMARY_MAX)
  assert.ok(!failed.error_summary.includes('\u0000'))
  assert.ok(Buffer.byteLength(failed.log_tail, 'utf8') <= LOG_TAIL_MAX_BYTES)
  assert.ok(failed.log_tail.startsWith('head') && failed.log_tail.endsWith('tail'), 'tête et queue conservées')
  assert.match(failed.log_tail, /log tronqué : 20008 octets/)
  assert.equal(failed.agent_version.length, 40)
  assert.deepEqual(sanitizeReport({ ...base, status: 'partial', log_tail: 'court' }).log_tail, 'court')
  assert.equal(sanitizeReport(base).log_tail, null, 'échec sans journal')
  assert.equal(sanitizeReport({ ...base, revision: null }).revision, null)
  for (const status of ['success', 'skipped']) {
    const report = sanitizeReport({ ...base, status, log_tail: 'PLAY [localhost] ***' })
    assert.deepEqual([report.log_tail, report.error_summary, report.agent_version], [null, null, null], status)
  }
})

// Sans VAPID dans l'environnement, sendPushToAll rend la main sans requête :
// seules la proposition et l'événement système touchent la base ici.
const failure = { id: 'r-1', deviceId: 'd-1', hostname: 'lx-1', revision: SHA('a'), error_summary: 'TASK [x] failed' }

test('alertApplyFailure : best-effort — une tâche rejetée est journalisée (une alerte par tâche), jamais remontée', async () => {
  const warn = mock.fn()
  let calls = 0
  const fastify = {
    db: { query: async () => { if (calls++ === 0) return { rows: [{ value: 'true' }] }; throw new Error('connexion perdue') } },
    log: { warn },
  }
  await alertApplyFailure(fastify, failure)
  assert.equal(warn.mock.callCount(), 2, 'proposition et événement système')
  for (const { arguments: [ctx, msg] } of warn.mock.calls) {
    assert.deepEqual(ctx, { err: 'connexion perdue', device_id: 'd-1' })
    assert.equal(msg, 'linux reports: alerte non envoyée')
  }
})

test('alertApplyFailure : lecture du réglage en échec → une alerte, rien de lancé, jamais remontée', async () => {
  const warn = mock.fn()
  const fastify = { db: { query: async () => { throw new Error('settings indisponibles') } }, log: { warn } }
  await alertApplyFailure(fastify, failure)
  assert.equal(warn.mock.callCount(), 1)
  assert.deepEqual(warn.mock.calls[0].arguments, [{ err: 'settings indisponibles', device_id: 'd-1' }, 'linux reports: alertes ignorées'])
})

test('recordReport : ligne par exécution, last_* du poste, last_successful_revision sur succès seul, audit sur transition seule', { skip: SKIP }, async () => {
  const device = await pullDevice('SN-RP-1')
  const failed = await send(device, { status: 'failed', error_summary: 'TASK [x] failed', log_tail: 'PLAY' })
  assert.equal(failed.transition, 'failed')
  assert.match(failed.id, /^[0-9a-f-]{36}$/)
  assert.ok(failed.received_at instanceof Date)
  assert.deepEqual(await state(device.id), {
    last_revision_applied: SHA('1'), last_successful_revision: null, last_apply_status: 'failed', last_apply_at: new Date('2026-09-30T20:00:41Z'),
  })
  // Toujours en échec : pas de transition, pas de nouvel audit.
  assert.equal((await send(device, { revision: SHA('2'), status: 'partial' })).transition, null)
  assert.equal((await audits(device.id)).length, 1)

  const recovered = await send(device, { revision: SHA('2'), status: 'success', finished_at: '2026-09-30T21:00:00Z' })
  assert.equal(recovered.transition, 'recovered')
  assert.deepEqual(await state(device.id), {
    last_revision_applied: SHA('2'), last_successful_revision: SHA('2'), last_apply_status: 'success', last_apply_at: new Date('2026-09-30T21:00:00Z'),
  })
  // skipped : la révision appliquée avance, la dernière réussie reste.
  assert.equal((await send(device, { revision: SHA('3'), status: 'skipped' })).transition, null)
  let current = await state(device.id)
  assert.deepEqual([current.last_revision_applied, current.last_successful_revision, current.last_apply_status], [SHA('3'), SHA('2'), 'skipped'])
  // Étape git en échec : révision nulle, nouveau passage en échec.
  assert.equal((await send(device, { revision: null, status: 'failed', error_summary: 'git: fatal' })).transition, 'failed')
  current = await state(device.id)
  assert.deepEqual([current.last_revision_applied, current.last_successful_revision, current.last_apply_status], [null, SHA('2'), 'failed'])

  const rows = await audits(device.id)
  assert.deepEqual(rows.map(r => r.action), ['linux_apply_failed', 'linux_apply_recovered', 'linux_apply_failed'])
  assert.equal(rows[0].by_user, 'device:' + FP.slice(0, 12))
  assert.deepEqual(rows[0].details, { level: 'error', revision: SHA('1'), hostname: 'lx-sn-rp-1', error_summary: 'TASK [x] failed' })
  assert.deepEqual(rows[1].details, { level: 'info', revision: SHA('2'), hostname: 'lx-sn-rp-1' })
  assert.deepEqual(rows[2].details, { level: 'error', revision: null, hostname: 'lx-sn-rp-1', error_summary: 'git: fatal' })
  const { rows: reports } = await db.query('SELECT status, log_tail FROM linux_apply_reports WHERE device_id = $1 ORDER BY received_at, id', [device.id])
  assert.deepEqual(reports.map(r => [r.status, r.log_tail]), [['failed', 'PLAY'], ['partial', null], ['success', null], ['skipped', null], ['failed', null]])

  // Poste non géré par état désiré : refus, rien d'écrit.
  const win = await seedDevice(db, { hostname: 'PC-RP' })
  await assert.rejects(send(win, {}), /sans poste pull/)
  assert.equal((await db.query('SELECT 1 FROM linux_apply_reports WHERE device_id = $1', [win.id])).rowCount, 0)
})

test('listReports : plus récent d’abord, filtre status, pagination, null hors poste pull', { skip: SKIP }, async () => {
  const device = await pullDevice('SN-RP-2')
  await send(device, { status: 'success', started_at: '2026-09-30T10:00:00Z' })
  await send(device, { revision: SHA('2'), status: 'failed', started_at: '2026-09-30T12:00:00Z', error_summary: 'TASK [y]', log_tail: 'PLAY' })
  await send(device, { revision: SHA('2'), status: 'skipped', started_at: '2026-09-30T11:00:00Z' })
  const all = await listReports(db, device.id)
  assert.equal(all.total, 3)
  assert.deepEqual(all.rows.map(r => r.status), ['failed', 'skipped', 'success'])
  assert.deepEqual(Object.keys(all.rows[0]).sort(), ['agent_version', 'error_summary', 'finished_at', 'id', 'log_tail', 'received_at', 'revision', 'started_at', 'status'])
  const failed = await listReports(db, device.id, { status: 'failed' })
  assert.deepEqual([failed.total, failed.rows[0].log_tail], [1, 'PLAY'])
  const page = await listReports(db, device.id, { limit: 1, offset: 1 })
  assert.deepEqual([page.total, page.rows.map(r => r.status)], [3, ['skipped']])
  assert.deepEqual(await listReports(db, device.id, { status: 'partial' }), { rows: [], total: 0 })
  const win = await seedDevice(db, { hostname: 'PC-RP-LIST' })
  assert.equal(await listReports(db, win.id), null)
})
