// Purge RGPD (plugins/cleanup.js) : durées de conservation lues dans
// lib/retention.js, seule source des constantes (partagée avec le
// nettoyage au fil de l'eau du checkin agent).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { runCleanup } from '../../plugins/cleanup.js'
import * as retention from '../../lib/retention.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const silentLog = { info() {}, warn() {}, error() {} }

let db, release, deviceId

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('PC-CLEANUP') RETURNING id`)
  deviceId = rows[0].id
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

const ago = (days) => `now() - interval '${days} days'`

async function count(table, where = 'true') {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)
  return rows[0].n
}

test('séries temporelles (bande passante, ping, perf) : purgées au-delà de 7 jours, y compris postes muets', { skip: SKIP }, async () => {
  // Poste qui ne fait plus de checkin : seul le cleanup quotidien purge
  // ses données (le checkin ne nettoie que le poste qui se présente).
  for (const days of [2, 10]) {
    await db.query(`INSERT INTO bandwidth_stats (device_id, adapter, sampled_at) VALUES ($1, 'eth0', ${ago(days)})`, [deviceId])
    await db.query(`INSERT INTO ping_stats (device_id, host, sampled_at) VALUES ($1, '1.1.1.1', ${ago(days)})`, [deviceId])
    await db.query(`INSERT INTO system_perf_stats (device_id, sampled_at) VALUES ($1, ${ago(days)})`, [deviceId])
  }
  await runCleanup({ db, log: silentLog })
  for (const table of ['bandwidth_stats', 'ping_stats', 'system_perf_stats']) {
    assert.equal(await count(table, `sampled_at < now() - interval '7 days'`), 0, `${table} : ligne de 10 j purgée`)
    assert.equal(await count(table), 1, `${table} : ligne de 2 j conservée`)
  }
})

test('sessions distantes, logs de session, audit, exécutions : durées inchangées', { skip: SKIP }, async () => {
  const { rows: [recent] } = await db.query(`INSERT INTO remote_sessions (device_id, transport, started_at) VALUES ($1, 'ssh', ${ago(20)}) RETURNING id`, [deviceId])
  const { rows: [old] } = await db.query(`INSERT INTO remote_sessions (device_id, transport, started_at) VALUES ($1, 'ssh', ${ago(200)}) RETURNING id`, [deviceId])
  await db.query(`INSERT INTO remote_session_logs (session_id, frames, size_bytes, created_at) VALUES ($1, '[]', 0, ${ago(40)})`, [recent.id])
  await db.query(`INSERT INTO audit_logs (action, created_at) VALUES ('t-old', ${ago(400)}), ('t-new', ${ago(300)})`)
  await db.query(`INSERT INTO script_executions (device_id, started_at) VALUES ($1, ${ago(100)}), ($1, ${ago(80)})`, [deviceId])

  await runCleanup({ db, log: silentLog })

  assert.equal(await count('remote_sessions', `id = '${old.id}'`), 0, '> 183 j purgée')
  assert.equal(await count('remote_sessions', `id = '${recent.id}'`), 1)
  assert.equal(await count('remote_session_logs'), 0, 'log de session > 30 j purgé')
  assert.deepEqual((await db.query(`SELECT action FROM audit_logs WHERE action LIKE 't-%'`)).rows, [{ action: 't-new' }])
  assert.equal(await count('script_executions'), 1, '> 90 j purgée')
})

test('lib/retention.js : une règle par table, tables et colonnes existantes', { skip: SKIP }, async () => {
  const rules = retention.RETENTION_RULES
  assert.ok(Array.isArray(rules) && rules.length >= 7)
  assert.equal(new Set(rules.map(r => r.table)).size, rules.length)
  for (const { table, col, days } of rules) {
    assert.ok(Number.isInteger(days) && days > 0, table)
    const { rows } = await db.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`, [table, col])
    assert.equal(rows.length, 1, `${table}.${col}`)
    assert.equal(retention.retentionDays(table), days)
  }
  assert.throws(() => retention.retentionDays('inconnue'), /inconnue/)
})
