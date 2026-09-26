// Migration 077 : met à NULL les ip_netbird écrites avant le contrôle de
// plage du check-in (100.64.0.0/10), trace chaque poste modifié dans
// audit_logs, et ne fait plus rien au second passage (le runner rejoue tout
// fichier non enregistré, la CI rejoue chaque migration deux fois).
// La définition « valide » doit rester celle du check-in (isNetbirdIp) : le
// test compare les deux sur chaque valeur semée.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'
import { isNetbirdIp } from '../../modules/inventory/lib/checkin-validation.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(__dirname, '../../migrations/077_clear_stale_ip_netbird.sql')

let db, release

before(async () => {
  if (!isDbAvailable()) return
  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

// Valeurs conservées : bornes et intérieur de 100.64.0.0/10.
const KEPT = ['100.64.0.0', '100.64.0.1', '100.100.1.2', '100.127.255.255', '100.99.0.199']

// Valeurs purgées : hors plage, IPv6, noms, formes non canoniques.
const CLEARED = [
  '10.0.0.5', '192.168.1.10', '127.0.0.1', '0.0.0.0',
  '100.63.255.255', '100.128.0.0', '101.64.0.1', '1100.64.0.1',
  '100.64.0.256', '100.64.256.1', '100.64.0',
  '100.064.0.1', '100.64.0.01', ' 100.64.0.1', '100.64.0.1 ', '100.64.0.1\n',
  '100.64.0.1/10', '::1', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1',
  'localhost', 'pc-compta.lan', '', '-oProxyCommand=calc',
]

test('077 — valeurs attendues alignées sur isNetbirdIp (check-in)', () => {
  for (const v of KEPT) assert.equal(isNetbirdIp(v), true, `${JSON.stringify(v)} devrait être valide`)
  for (const v of CLEARED) assert.equal(isNetbirdIp(v), false, `${JSON.stringify(v)} devrait être invalide`)
})

test('077 — purge les ip_netbird hors 100.64.0.0/10, trace chaque poste, idempotente', { skip: SKIP }, async () => {
  const sql = await fs.readFile(MIGRATION, 'utf8')

  const seeded = []
  for (const [i, ip] of [...KEPT, ...CLEARED].entries()) {
    seeded.push({ ip, ...(await seedDevice(db, { hostname: `PC-MIG-077-${i}`, ipNetbird: ip })) })
  }
  const noIp = await seedDevice(db, { hostname: 'PC-MIG-077-NULL' })
  // Entrée d'audit préexistante : ne doit être ni modifiée ni dupliquée.
  await db.query(
    `INSERT INTO audit_logs (action, by_user, target) VALUES ('agent_checkin', 'PC-X', $1)`, [noIp.id]
  )
  const auditBefore = (await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n

  await db.query(sql)

  for (const d of seeded) {
    const { rows: [row] } = await db.query('SELECT ip_netbird FROM devices WHERE id = $1', [d.id])
    const expected = isNetbirdIp(d.ip) ? d.ip : null
    assert.equal(row.ip_netbird, expected, `ip_netbird ${JSON.stringify(d.ip)}`)
  }
  const { rows: [nullRow] } = await db.query('SELECT ip_netbird FROM devices WHERE id = $1', [noIp.id])
  assert.equal(nullRow.ip_netbird, null)

  // Une entrée d'audit par poste purgé, portant la valeur retirée.
  const { rows: audits } = await db.query(
    `SELECT by_user, target, details FROM audit_logs WHERE action = 'ip_netbird_cleared' ORDER BY target`
  )
  const clearedDevices = seeded.filter(d => !isNetbirdIp(d.ip))
  assert.equal(audits.length, CLEARED.length)
  assert.deepEqual(
    audits.map(a => a.target).sort(),
    clearedDevices.map(d => d.id).sort(),
  )
  for (const a of audits) {
    const d = clearedDevices.find(x => x.id === a.target)
    assert.equal(a.by_user, 'migration 077')
    assert.deepEqual(a.details, { level: 'warn', hostname: d.hostname, ip_netbird: d.ip })
  }

  // Second passage : ni donnée ni audit modifiés.
  const snapshot = async () => ({
    devices: (await db.query('SELECT id, ip_netbird FROM devices ORDER BY id')).rows,
    audit: (await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,
  })
  const afterFirst = await snapshot()
  assert.equal(afterFirst.audit, auditBefore + CLEARED.length)
  await db.query(sql)
  assert.deepEqual(await snapshot(), afterFirst)
})

test('077 — valeur démesurée : tronquée à 64 caractères dans l\'audit, purgée', { skip: SKIP }, async () => {
  const sql = await fs.readFile(MIGRATION, 'utf8')
  const long = 'x'.repeat(5000)
  const dev = await seedDevice(db, { hostname: 'PC-MIG-077-LONG', ipNetbird: long })

  await db.query(sql)

  const { rows: [row] } = await db.query('SELECT ip_netbird FROM devices WHERE id = $1', [dev.id])
  assert.equal(row.ip_netbird, null)
  const { rows: [a] } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'ip_netbird_cleared' AND target = $1`, [dev.id]
  )
  assert.equal(a.details.ip_netbird, 'x'.repeat(64))
})
