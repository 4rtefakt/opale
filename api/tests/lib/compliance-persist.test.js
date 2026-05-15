// Tests d'intégration de evaluateAndPersist (api/lib/compliance.js).
//
// Couvre le contrat documenté dans le fichier :
//   - upsert d'un row par règle dans compliance_results
//   - audit_logs 'compliance_changed' uniquement sur transition pass↔fail
//     (les transitions impliquant not_applicable sont ignorées)
//   - ticket_proposals idempotent sur transition pass→fail high/critical
//     UNIQUEMENT si setting compliance_alerts_enabled = 'true'
//   - aucun throw même si une règle individuelle crash
//
// Skip si PG_TEST_URL absent. push_subscriptions est laissée vide → le hook
// push (sendPushToAll dans routes/push.js) early-return sans tenter d'envoi.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { evaluateAndPersist, RULES } from '../../modules/monitoring/lib/compliance.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip compliance-persist suite'

let schema, db, release, fastify, logCapture

// Snapshot "tout pass" — passes les 12 règles. Sert de baseline ; les tests
// le clonent et tweakent les champs voulus pour forcer un fail.
function snapshotAllPass(overrides = {}) {
  return {
    hostname: 'PC-TEST',
    last_seen: new Date().toISOString(),
    agent_version: '2.14.0',
    latest_agent_version: '2.14.0',
    disk_c_used_pct: 50,
    compliance_state: 'compliant',
    health: {
      bitlocker: { volume: 'C:', protection_status: 'on' },
      defender: {
        antivirus_enabled: true,
        realtime_protection: true,
        signature_age_days: 1,
        threats_last_30d: 0,
      },
      firewall: { domain_enabled: true, private_enabled: true, public_enabled: true },
      last_windows_update: new Date().toISOString().slice(0, 10),
      pending_reboot: false,
    },
    ...overrides,
  }
}

// Insert un device dans la table devices et retourne son id (UUID généré).
async function insertDevice(hostname) {
  const r = await db.query(
    `INSERT INTO devices (hostname, last_seen) VALUES ($1, now()) RETURNING id`,
    [hostname]
  )
  return r.rows[0].id
}

before(async () => {
  if (!isDbAvailable()) return
  // VAPID désarmé → sendPushToAll early-return sans rien envoyer.
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  // logCapture remplace fastify.log — on inspecte les .warn() pour vérifier
  // que evaluateAndPersist log au lieu de throw.
  logCapture = { warns: [], infos: [] }
  fastify = {
    db,
    log: {
      warn: (obj, msg) => { logCapture.warns.push({ obj, msg }) },
      info: (obj, msg) => { logCapture.infos.push({ obj, msg }) },
      error: () => {},
    },
  }
})

after(async () => {
  if (release) await release()
  await closeSharedPool()
})

test('evaluateAndPersist — premier eval : upsert 12 rows pass', { skip: SKIP }, async () => {
  const deviceId = await insertDevice('PC-FIRST')
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass())

  const { rows } = await db.query(
    `SELECT rule_id, status, severity FROM compliance_results WHERE device_id = $1 ORDER BY rule_id`,
    [deviceId]
  )
  assert.equal(rows.length, RULES.length, '12 rows attendus')
  for (const r of rows) {
    assert.equal(r.status, 'pass', `row ${r.rule_id} doit passer avec un snapshot all-pass`)
  }
})

test('evaluateAndPersist — 2e eval avec transition pass→fail logge audit + UPDATE row', { skip: SKIP }, async () => {
  const deviceId = await insertDevice('PC-TRANSITION')
  // 1er eval : tout pass.
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass())

  // 2e eval : disk_c_used_pct passe à 95 → disk_c_under_90 doit fail.
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass({ disk_c_used_pct: 95 }))

  const { rows: results } = await db.query(
    `SELECT status FROM compliance_results WHERE device_id = $1 AND rule_id = 'disk_c_under_90'`,
    [deviceId]
  )
  assert.equal(results[0].status, 'fail')

  const { rows: audits } = await db.query(
    `SELECT action, by_user, target, details FROM audit_logs
     WHERE action = 'compliance_changed' AND target = $1`,
    [deviceId]
  )
  assert.equal(audits.length, 1, 'exactement 1 entrée audit pour cette transition')
  const details = audits[0].details
  assert.equal(details.rule_id, 'disk_c_under_90')
  assert.equal(details.from, 'pass')
  assert.equal(details.to, 'fail')
  assert.equal(details.severity, 'medium')
})

test('evaluateAndPersist — transitions impliquant not_applicable NE déclenchent PAS d\'audit', { skip: SKIP }, async () => {
  const deviceId = await insertDevice('PC-NA-TRANSITION')
  // 1er eval : tout pass.
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass())

  // 2e eval : retire le bloc defender entier → defender_* basculent en N/A.
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass({
    health: { ...snapshotAllPass().health, defender: undefined },
  }))

  const { rows: audits } = await db.query(
    `SELECT details->>'rule_id' AS rule_id, details->>'to' AS to FROM audit_logs
     WHERE action = 'compliance_changed' AND target = $1`,
    [deviceId]
  )
  // pass→not_applicable doit être ignoré : aucune ligne defender_* dans audit.
  for (const a of audits) {
    assert.notMatch(a.rule_id, /^defender_/,
      `transition vers not_applicable ne doit pas être auditée (${a.rule_id} → ${a.to})`)
  }
})

test('evaluateAndPersist — règle dont evaluate() throw → warn log + autres règles continuent', { skip: SKIP }, async () => {
  const deviceId = await insertDevice('PC-THROW')

  // Patch ad hoc : on monkey-patch evaluate de la 1ère règle pour throw une
  // fois. evaluateAndPersist doit logger et continuer (les 11 autres règles
  // doivent quand même upsert leur row).
  const target = RULES[0]
  const originalEvaluate = target.evaluate
  target.evaluate = () => { throw new Error('evaluate boom de test') }

  try {
    logCapture.warns.length = 0
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass())

    const { rows } = await db.query(
      `SELECT rule_id FROM compliance_results WHERE device_id = $1`,
      [deviceId]
    )
    assert.equal(rows.length, RULES.length - 1,
      `11 rows attendus (la règle ${target.id} skip car throw)`)
    assert.ok(
      logCapture.warns.some(w => w.msg && w.msg.includes('threw')),
      'un warn doit avoir été émis pour la règle qui throw'
    )
  } finally {
    target.evaluate = originalEvaluate
  }
})

test('evaluateAndPersist — alerts désactivés (défaut) : pas de ticket_proposal sur pass→fail', { skip: SKIP }, async () => {
  const deviceId = await insertDevice('PC-NO-ALERT')
  // Pas de seed du setting compliance_alerts_enabled → SELECT renverra
  // rien → la fonction lit `false` (cf. defaults to false dans le code).

  await evaluateAndPersist(fastify, deviceId, snapshotAllPass())
  await evaluateAndPersist(fastify, deviceId, snapshotAllPass({
    health: { ...snapshotAllPass().health, defender: { antivirus_enabled: false, realtime_protection: true, signature_age_days: 1, threats_last_30d: 0 } },
  }))

  // Vérifie qu'il y a bien un audit (transition pass→fail capturée)
  // mais PAS de ticket_proposal pending.
  const { rows: audits } = await db.query(
    `SELECT details->>'rule_id' AS rule_id FROM audit_logs WHERE target = $1 AND action = 'compliance_changed'`,
    [deviceId]
  )
  assert.ok(audits.some(a => a.rule_id === 'defender_av_active'), 'audit attendu')

  const { rows: props } = await db.query(
    `SELECT id FROM ticket_proposals WHERE source = 'compliance' AND source_payload->>'device_id' = $1`,
    [deviceId]
  )
  assert.equal(props.length, 0, 'aucune proposal car alerts désactivés')
})

test('evaluateAndPersist — alerts activés : pass→fail d\'une règle critical crée 1 proposal', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('compliance_alerts_enabled', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`
  )
  try {
    const deviceId = await insertDevice('PC-ALERT')

    // pass → fail sur defender_av_active (critical).
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass())
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass({
      health: { ...snapshotAllPass().health, defender: { antivirus_enabled: false, realtime_protection: true, signature_age_days: 1, threats_last_30d: 0 } },
    }))

    // Attente pour laisser la création de proposal (fire-and-forget) se résoudre.
    await new Promise(r => setTimeout(r, 100))

    const { rows: props } = await db.query(
      `SELECT id, suggested_priority, source_payload FROM ticket_proposals
       WHERE source = 'compliance' AND source_payload->>'device_id' = $1`,
      [deviceId]
    )
    assert.equal(props.length, 1, '1 proposal attendue (critical)')
    assert.equal(props[0].suggested_priority, 'critical')
    assert.equal(props[0].source_payload.rule_id, 'defender_av_active')
  } finally {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'compliance_alerts_enabled'`)
  }
})

test('evaluateAndPersist — proposal idempotent : 2e transition pass→fail pendant 1 proposal pending ne re-crée pas', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('compliance_alerts_enabled', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`
  )
  try {
    const deviceId = await insertDevice('PC-IDEMPOTENT')

    // pass → fail (#1).
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass())
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass({
      health: { ...snapshotAllPass().health, defender: { antivirus_enabled: false, realtime_protection: true, signature_age_days: 1, threats_last_30d: 0 } },
    }))
    await new Promise(r => setTimeout(r, 100))

    // fail → pass.
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass())
    // pass → fail à nouveau (#2). Devrait NE PAS re-créer car la 1ère
    // proposal est encore pending.
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass({
      health: { ...snapshotAllPass().health, defender: { antivirus_enabled: false, realtime_protection: true, signature_age_days: 1, threats_last_30d: 0 } },
    }))
    await new Promise(r => setTimeout(r, 100))

    const { rows: props } = await db.query(
      `SELECT id, status FROM ticket_proposals
       WHERE source = 'compliance' AND source_payload->>'device_id' = $1
         AND source_payload->>'rule_id' = 'defender_av_active'`,
      [deviceId]
    )
    assert.equal(props.length, 1, 'une seule proposal malgré 2 transitions pass→fail')
    assert.equal(props[0].status, 'pending')
  } finally {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'compliance_alerts_enabled'`)
  }
})

test('evaluateAndPersist — alerts activés : règle low/medium ne crée PAS de proposal', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('compliance_alerts_enabled', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`
  )
  try {
    const deviceId = await insertDevice('PC-LOW-ALERT')

    // pass → fail sur disk_c_under_90 (medium). Le code n'alerte que
    // ALERTING_SEVERITIES = high+critical (cf. compliance.js).
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass())
    await evaluateAndPersist(fastify, deviceId, snapshotAllPass({ disk_c_used_pct: 95 }))
    await new Promise(r => setTimeout(r, 100))

    const { rows: props } = await db.query(
      `SELECT id FROM ticket_proposals
       WHERE source = 'compliance' AND source_payload->>'device_id' = $1`,
      [deviceId]
    )
    assert.equal(props.length, 0, 'aucune proposal pour severity medium')
  } finally {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'compliance_alerts_enabled'`)
  }
})
