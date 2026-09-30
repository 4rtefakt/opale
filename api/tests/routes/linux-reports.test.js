// POST /api/linux/agent/reports (docs/linux-fleet-design.md §4) : clé
// approuvée seulement, réponse ReportAck, ligne de rapport et état last_* du
// poste, audits sur transition seule, alertes (push admin, proposition de
// ticket idempotente, événement sur les tickets ouverts) derrière
// linux.alerts_enabled, limite par poste. Base réelle, web-push simulé.

import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import webpush from 'web-push'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { report } from '../helpers/linux-agent.js'
import { seedAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { seedPushSubscription } from '../fixtures/push-subscriptions.js'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'
import { loadSpec, deref } from '../../modules/linux/lib/spec.js'
import agentRoutes from '../../modules/linux/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const SHA = c => c.repeat(40)

let db, release, app, tokenStore, validate
const prevEnv = {}
const gitMirror = { serving: () => true, heads: () => ({ pilot: SHA('a'), stable: SHA('b'), upstream: {} }) }

before(async () => {
  if (SKIP) return
  // Clés VAPID jetables : sendPushToAll arme web-push, dont l'envoi est simulé.
  const keys = webpush.generateVAPIDKeys()
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL']) prevEnv[k] = process.env[k]
  process.env.VAPID_PUBLIC_KEY  = keys.publicKey
  process.env.VAPID_PRIVATE_KEY = keys.privateKey
  process.env.VAPID_EMAIL       = 'test@example.com'
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  tokenStore = createGitTokenStore()
  app = await buildApp({
    db, registerAuth: false, decorators: { gitMirror, gitTokenStore: tokenStore },
    routes: f => f.register(agentRoutes, { prefix: '/api/linux/agent' }),
  })
  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  validate = ajv.compile(deref(loadSpec().components.schemas.ReportAck))
})

after(async () => {
  if (app) await app.close()
  tokenStore?.stop()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

let ipSeq = 0
const nextIp = () => `203.0.113.${++ipSeq}`

async function approvedAgent(serial) {
  const device = await seedDevice(db, { hostname: `lx-${serial.toLowerCase()}`, serial, platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const key = await seedLinuxDeviceKey(db, { deviceId: device.id, status: 'approved', serialClaimed: serial })
  return { device, key, privateKey: key.privateKey, fingerprint: key.fingerprint, body: { serial, agent_version: '0.2.0' } }
}

async function state(id) {
  const { rows: [row] } = await db.query('SELECT last_revision_applied, last_successful_revision, last_apply_status, last_apply_at FROM devices WHERE id = $1', [id])
  return row
}

async function audits(id) {
  const { rows } = await db.query("SELECT action, by_user, details FROM audit_logs WHERE target = $1 AND action LIKE 'linux_apply_%' ORDER BY created_at, id", [id])
  return rows
}

const proposals = id => db.query("SELECT * FROM ticket_proposals WHERE source = 'linux_apply' AND source_payload->>'device_id' = $1 ORDER BY created_at, id", [id]).then(r => r.rows)

// Les alertes partent hors du chemin de réponse : on attend leurs effets.
async function until(check, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`délai dépassé en attendant : ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
// Pour vérifier qu'aucune alerte ne part : laisse le temps à un envoi fautif d'apparaître.
const settle = () => new Promise(r => setTimeout(r, 100))

test('/reports — clé pending → 401 NOT_APPROVED ; sans signature → 401 ; corps hors schéma → 400', { skip: SKIP }, async () => {
  const pending = await seedLinuxDeviceKey(db, { status: 'pending', serialClaimed: 'SN-RP-PENDING' })
  const agent = { ...pending, body: { serial: 'SN-RP-PENDING', agent_version: '0.1.0' } }
  const res = await report(app, agent, { ip: nextIp() })
  assert.equal(res.statusCode, 401, res.body)
  assert.equal(res.json().code, 'NOT_APPROVED')
  const bare = await app.inject({ method: 'POST', url: '/api/linux/agent/reports', remoteAddress: nextIp(), payload: { revision: SHA('a'), status: 'success' } })
  assert.equal(bare.statusCode, 401)
  const approved = await approvedAgent('SN-RP-SCHEMA')
  assert.equal((await report(app, approved, { ip: nextIp(), body: { revision: 'pas-un-sha' } })).statusCode, 400)
  assert.equal((await report(app, approved, { ip: nextIp(), body: { status: 'exploded' } })).statusCode, 400)
  assert.equal((await db.query('SELECT 1 FROM linux_apply_reports WHERE device_id = $1', [approved.device.id])).rowCount, 0)
})

test('/reports — 201 ReportAck ; ligne par exécution (journal tronqué, nul sur succès), last_* du poste, audits sur transition seule', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-RP-OK')
  const ip = nextIp()
  const failed = await report(app, agent, { ip, body: { status: 'failed', error_summary: 'TASK [base] — apt: paquet introuvable', log_tail: 'PLAY [localhost]\n' + 'x'.repeat(30_000) + '\nfatal' } })
  assert.equal(failed.statusCode, 201, failed.body)
  const ack = failed.json()
  assert.ok(validate(ack), JSON.stringify(validate.errors))
  assert.equal(ack.transition, 'failed')
  assert.ok(Date.now() - Date.parse(ack.received_at) < 60_000)
  const { rows: [row] } = await db.query('SELECT device_id, revision, status, error_summary, log_tail, agent_version FROM linux_apply_reports WHERE id = $1', [ack.id])
  assert.deepEqual([row.device_id, row.revision, row.status, row.error_summary, row.agent_version], [agent.device.id, SHA('a'), 'failed', 'TASK [base] — apt: paquet introuvable', '0.2.0'])
  assert.ok(Buffer.byteLength(row.log_tail, 'utf8') <= 8192)
  assert.ok(row.log_tail.startsWith('PLAY [localhost]') && row.log_tail.endsWith('fatal'))
  let current = await state(agent.device.id)
  assert.deepEqual([current.last_revision_applied, current.last_successful_revision, current.last_apply_status], [SHA('a'), null, 'failed'])
  assert.ok(Date.now() - new Date(current.last_apply_at).getTime() < 60_000)
  assert.equal((await audits(agent.device.id)).length, 1)

  const still = await report(app, agent, { ip, body: { status: 'partial', log_tail: 'PLAY' } })
  assert.equal(still.json().transition, null, 'toujours en échec')
  assert.equal((await audits(agent.device.id)).length, 1, 'pas de nouvel audit')

  const ok = await report(app, agent, { ip, body: { revision: SHA('b'), status: 'success', log_tail: 'ignoré' } })
  assert.equal(ok.statusCode, 201, ok.body)
  assert.equal(ok.json().transition, 'recovered')
  current = await state(agent.device.id)
  assert.deepEqual([current.last_revision_applied, current.last_successful_revision, current.last_apply_status], [SHA('b'), SHA('b'), 'success'])
  const { rows: [success] } = await db.query('SELECT log_tail FROM linux_apply_reports WHERE id = $1', [ok.json().id])
  assert.equal(success.log_tail, null)

  const skipped = await report(app, agent, { ip, body: { revision: SHA('c'), status: 'skipped' } })
  assert.equal(skipped.json().transition, null)
  current = await state(agent.device.id)
  assert.deepEqual([current.last_revision_applied, current.last_successful_revision, current.last_apply_status], [SHA('c'), SHA('b'), 'skipped'])

  const rows = await audits(agent.device.id)
  assert.deepEqual(rows.map(r => r.action), ['linux_apply_failed', 'linux_apply_recovered'])
  assert.equal(rows[0].by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.deepEqual(rows[0].details, { level: 'error', revision: SHA('a'), hostname: 'lx-sn-rp-ok', error_summary: 'TASK [base] — apt: paquet introuvable' })
  assert.deepEqual(rows[1].details, { level: 'info', revision: SHA('b'), hostname: 'lx-sn-rp-ok' })
  assert.equal((await db.query('SELECT 1 FROM linux_apply_reports WHERE device_id = $1', [agent.device.id])).rowCount, 4)
  assert.deepEqual(await proposals(agent.device.id), [], 'alertes inactives par défaut')
})

test('/reports — alertes actives : push aux admins, proposition unique tant qu’elle est en attente, événement sur les tickets ouverts seulement', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-RP-ALERT')
  const ip = nextIp()
  await db.query("UPDATE settings SET value = 'true' WHERE key = 'linux.alerts_enabled'")
  await seedAdmin(db, { entraId: 'oid-rp-admin', displayName: 'Admin Rapports', email: 'admin-rp@x' })
  await seedPushSubscription(db, { userEntraId: 'oid-rp-admin', endpoint: 'https://push.example.com/sub/rp-admin' })
  const { rows: [open] } = await db.query("INSERT INTO tickets (title, device_id) VALUES ('Lenteurs', $1) RETURNING id", [agent.device.id])
  const { rows: [closed] } = await db.query("INSERT INTO tickets (title, device_id, status) VALUES ('Ancien', $1, 'resolved') RETURNING id", [agent.device.id])
  const sent = []
  const spy = mock.method(webpush, 'sendNotification', async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) }) })
  const events = ticketId => db.query("SELECT type, author, content FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at, id", [ticketId]).then(r => r.rows)
  try {
    const res = await report(app, agent, { ip, body: { status: 'failed', error_summary: 'TASK [base : install] — apt: Unable to locate package foo' } })
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(res.json().transition, 'failed')
    await until(() => sent.length === 1, 'push')
    assert.equal(sent[0].endpoint, 'https://push.example.com/sub/rp-admin')
    assert.equal(sent[0].title, '⚠ Linux — lx-sn-rp-alert')
    assert.equal(sent[0].body, 'Application de la configuration en échec (aaaaaaa) : TASK [base : install] — apt: Unable to locate package foo')
    assert.equal(sent[0].url, `/mobile.html#/poste/${agent.device.id}`)
    assert.equal(sent[0].deviceId, agent.device.id)
    await until(async () => (await proposals(agent.device.id)).length === 1, 'proposition')
    let rows = await proposals(agent.device.id)
    assert.deepEqual([rows[0].status, rows[0].suggested_priority, rows[0].suggested_device_id, rows[0].source_ref_type, rows[0].source_ref_id],
      ['pending', 'high', agent.device.id, 'linux_apply_report', res.json().id])
    assert.equal(rows[0].suggested_title, 'Linux : application en échec — lx-sn-rp-alert')
    assert.match(rows[0].suggested_description, /Unable to locate package foo/)
    assert.deepEqual(rows[0].source_payload, { device_id: agent.device.id, report_id: res.json().id, revision: SHA('a'), error_summary: 'TASK [base : install] — apt: Unable to locate package foo' })
    await until(async () => (await events(open.id)).length === 1, 'événement système')
    assert.deepEqual(await events(open.id), [{ type: 'system', author: 'Système', content: 'Application Linux en échec (aaaaaaa) : TASK [base : install] — apt: Unable to locate package foo' }])
    assert.deepEqual(await events(closed.id), [], 'ticket résolu ignoré')

    // Rétablissement : rien. Nouvel échec : push et événement, mais la proposition en attente n'est pas doublée.
    assert.equal((await report(app, agent, { ip, body: { status: 'success' } })).json().transition, 'recovered')
    await settle()
    assert.equal(sent.length, 1)
    assert.equal((await report(app, agent, { ip, body: { revision: null, status: 'failed', error_summary: 'git: fatal' } })).json().transition, 'failed')
    await until(() => sent.length === 2, 'second push')
    assert.equal(sent[1].body, 'Application de la configuration en échec (révision inconnue) : git: fatal')
    await until(async () => (await events(open.id)).length === 2, 'second événement')
    await settle()
    assert.equal((await proposals(agent.device.id)).length, 1, 'proposition en attente réutilisée')

    // Proposition traitée par l'admin : la transition suivante en recrée une.
    await db.query("UPDATE ticket_proposals SET status = 'rejected' WHERE source = 'linux_apply' AND source_payload->>'device_id' = $1", [agent.device.id])
    await report(app, agent, { ip, body: { status: 'skipped' } })
    await report(app, agent, { ip, body: { status: 'partial' } })
    await until(async () => (await proposals(agent.device.id)).length === 2, 'nouvelle proposition')
    rows = await proposals(agent.device.id)
    assert.deepEqual(rows.map(r => r.status), ['rejected', 'pending'])
    await until(() => sent.length === 3, 'troisième push')

    // Alertes coupées : la transition est toujours auditée, sans push ni proposition.
    await db.query("UPDATE settings SET value = 'false' WHERE key = 'linux.alerts_enabled'")
    await report(app, agent, { ip, body: { status: 'success' } })
    assert.equal((await report(app, agent, { ip, body: { status: 'failed' } })).json().transition, 'failed')
    await settle()
    assert.equal(sent.length, 3)
    assert.equal((await proposals(agent.device.id)).length, 2)
    assert.equal((await audits(agent.device.id)).filter(a => a.action === 'linux_apply_failed').length, 4)
  } finally {
    spy.mock.restore()
    await db.query("UPDATE settings SET value = 'false' WHERE key = 'linux.alerts_enabled'")
  }
})

test('/reports — 12 par heure et par poste : le 13e → 429 DEVICE_RATE_LIMIT, rien d’écrit ; un autre poste passe', { skip: SKIP }, async () => {
  const agent = await approvedAgent('SN-RP-RATE')
  const other = await approvedAgent('SN-RP-RATE-2')
  const ip = nextIp()
  for (let i = 0; i < 12; i++) assert.equal((await report(app, agent, { ip })).statusCode, 201, `passage ${i + 1}`)
  const res = await report(app, agent, { ip })
  assert.equal(res.statusCode, 429, res.body)
  const body = res.json()
  assert.equal(body.code, 'DEVICE_RATE_LIMIT')
  assert.ok(body.retry_after_ms > 0 && body.retry_after_ms <= 3600_000)
  assert.equal(res.headers['retry-after'], String(Math.ceil(body.retry_after_ms / 1000)))
  assert.equal((await db.query('SELECT 1 FROM linux_apply_reports WHERE device_id = $1', [agent.device.id])).rowCount, 12)
  assert.equal((await report(app, other, { ip })).statusCode, 201, 'limite par poste, pas par IP')
})
