// Parcours d'enrôlement Linux de bout en bout (docs/linux-fleet-design.md §3) :
// agent signé (/api/linux/agent/enroll) + admin JWT (/api/linux/enrollments…)
// + ingress legacy (/api/agent) sur un poste converti. App montée comme en
// prod : rate-limit, handler d'erreur global, module linux complet.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import rateLimit from '@fastify/rate-limit'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { newAgent, enroll, checkin, report } from '../helpers/linux-agent.js'
import { createFleetRepo } from '../helpers/linux-fleet-repo.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { rateLimitOptions } from '../../lib/rate-limit.js'
import errorHandlerPlugin from '../../plugins/error-handler.js'
import linux from '../../modules/linux/index.js'
import agentRoute from '../../modules/inventory/routes/agent.js'
import { PENDING_CAP } from '../../modules/linux/lib/enrollment.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, app, jwt, admin, cli, repo
const evicted = []
const prevEnv = { LINUX_GIT_DIR: process.env.LINUX_GIT_DIR, HOME: process.env.HOME, FRONTEND_URL: process.env.FRONTEND_URL, LAPS_PRIVATE_KEY: process.env.LAPS_PRIVATE_KEY }

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  // Miroir git du module sur un dépôt de flotte temporaire (HOME vide : aucun ~/.gitconfig).
  repo = await createFleetRepo()
  await repo.commit({ message: 'initial', files: { 'profiles/field.yml': '---\n' } })
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.repo_url'", [repo.url])
  process.env.LINUX_GIT_DIR = `${repo.root}/mirror`
  process.env.HOME = repo.home
  process.env.FRONTEND_URL = 'https://opale.test'
  // Escrow indisponible quel que soit l'environnement du développeur (laps.key locale, variable exportée).
  process.env.LAPS_PRIVATE_KEY = `${repo.root}/absent.key`
  app = await buildApp({
    db,
    jwks: jwt.jwks,
    decorators: { agentWs: { evictDevice: (id, reason) => evicted.push([id, reason]), evictTokens: () => {} } },
    routes: async f => {
      await f.register(rateLimit, rateLimitOptions)
      await f.register(errorHandlerPlugin)
      await linux.register(f)
      await f.register(agentRoute, { prefix: '/api/agent' })
    },
  })
  const a = await seedAdmin(db, { entraId: 'oid-lx-admin', displayName: 'Admin Linux', email: 'admin-linux@x' })
  admin = { authorization: `Bearer ${await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email })}` }
  await seedNonAdmin(db, { entraId: 'oid-lx-user', displayName: 'Utilisateur Lx', email: 'lx.user@x' })
  // Token CLI du même admin : accepté partout sauf sur les opérations interactives.
  const secret = crypto.randomBytes(32).toString('hex')
  await db.query('INSERT INTO cli_tokens (entra_id, label, token_hash) VALUES ($1, $2, $3)',
    ['oid-lx-admin', 'cli', crypto.createHash('sha256').update(secret).digest('hex')])
  cli = { authorization: `Bearer opl_${secret}` }
  await app.gitMirror.start(db)
  assert.equal(app.gitMirror.status().state, 'ready')
})

after(async () => {
  if (app) await linux.stopWorkers(app)
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
  await repo?.cleanup()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

const api = (method, url, { headers = admin, payload } = {}) => app.inject({ method, url, headers, payload })
const approve = (id, payload, headers) => api('POST', `/api/linux/enrollments/${id}/approve`, { payload, headers })

async function audits(action, target) {
  const { rows } = await db.query(
    'SELECT by_user, details FROM audit_logs WHERE action = $1 AND target = $2 ORDER BY created_at, id', [action, target]
  )
  return rows
}

async function keyOf(agent) {
  const { rows: [row] } = await db.query('SELECT * FROM linux_device_keys WHERE key_fingerprint = $1', [agent.fingerprint])
  return row
}

// Un identifiant d'IP par test : les compteurs rate-limit sont en mémoire.
let ipSeq = 0
const nextIp = () => `203.0.113.${++ipSeq}`

test('série pré-inscrite → /enroll 200 approved avec le nom et l’utilisateur réservés ; relance idempotente', { skip: SKIP }, async () => {
  await db.query(`
    INSERT INTO linux_preregistrations (serial, hostname, profile, ring, assigned_user_id, created_by)
    VALUES ('SN-FLOW-PRE', 'lx-flow-pre', 'field', 'stable', 'oid-lx-user', 'test')
  `)
  const agent = newAgent({ serial: ' sn-flow-pre ' })
  const ip = nextIp()
  const res = await enroll(app, agent, { ip })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.status, 'approved')
  assert.equal(body.hostname, 'lx-flow-pre')
  const { rows: [device] } = await db.query('SELECT * FROM devices WHERE id = $1', [body.device_id])
  assert.equal(device.platform, 'linux')
  assert.equal(device.managed_by, 'pull')
  assert.equal(device.serial, 'SN-FLOW-PRE')
  assert.equal(device.profile, 'field')
  assert.equal(device.ring, 'stable')
  assert.equal(device.assigned_user_id, 'oid-lx-user')
  const key = await keyOf(agent)
  assert.equal(key.status, 'approved')
  assert.equal(key.source, 'preregistration')
  assert.equal(key.device_id, device.id)
  const { rows: [prereg] } = await db.query("SELECT consumed_at, consumed_by_key_id FROM linux_preregistrations WHERE serial = 'SN-FLOW-PRE'")
  assert.ok(prereg.consumed_at)
  assert.equal(prereg.consumed_by_key_id, key.id)
  const [audit] = await audits('linux_device_enrolled', device.id)
  assert.equal(audit.by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.equal(audit.details.source, 'preregistration')

  const again = await enroll(app, agent, { ip })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(again.json().device_id, device.id)
  assert.equal((await keyOf(agent)).enroll_attempts, 2)

  // Check-in signé : affectation de la pré-inscription, token git du miroir prêt, puis 401 après révocation.
  const assigned = await checkin(app, agent, { ip, body: { disk_root_pct: 12 } })
  assert.equal(assigned.statusCode, 200, assigned.body)
  const a = assigned.json()
  assert.deepEqual([a.device_id, a.hostname, a.profile, a.ring], [device.id, 'lx-flow-pre', 'field', 'stable'])
  assert.equal(a.revision, null, 'stable jamais promu')
  assert.equal(a.git.url, 'https://opale.test/api/linux/agent/git/fleet.git')
  const entry = app.gitTokenStore.verify(a.git.token)
  assert.equal(entry.deviceId, device.id)
  assert.equal(entry.expired, false)
  assert.equal(a.escrow.status, 'unavailable', 'LAPS_PRIVATE_KEY pointe sur un fichier absent')
  assert.deepEqual(a.escrow_needed, [], 'rien à chiffrer sans clé')
  const { rows: [seen] } = await db.query('SELECT last_seen, disk_used_pct, hostname FROM devices WHERE id = $1', [device.id])
  assert.ok(Date.now() - new Date(seen.last_seen).getTime() < 60_000)
  assert.equal(Number(seen.disk_used_pct), 12)
  assert.equal(seen.hostname, 'lx-flow-pre')
  const revoked = await api('POST', `/api/linux/devices/${device.id}/revoke`, { payload: { reason: 'Poste perdu' } })
  assert.equal(revoked.statusCode, 200, revoked.body)
  const refused = await checkin(app, agent, { ip })
  assert.equal(refused.statusCode, 401, refused.body)
  assert.equal(refused.json().code, 'REVOKED')
})

test('série inconnue → 202 pending (code, 30 s) → file d’attente → approbation admin → poste créé, clé liée, audits → /enroll 200', { skip: SKIP }, async () => {
  const agent = newAgent({ serial: 'SN-FLOW-NEW', hostname: 'debian-new' })
  const ip = nextIp()
  const pending = await enroll(app, agent, { ip })
  assert.equal(pending.statusCode, 202, pending.body)
  assert.deepEqual(pending.json(), { status: 'pending', code: agent.code, retry_after_s: 30, conflict: null })
  const key = await keyOf(agent)

  // Sans Bearer / non-admin : refusés avant toute lecture.
  assert.equal((await api('GET', '/api/linux/enrollments', { headers: {} })).statusCode, 401)
  const user = await seedNonAdmin(db, { entraId: 'oid-lx-nonadmin' })
  const userJwt = { authorization: `Bearer ${await jwt.sign({ oid: user.entraId, name: user.displayName, preferred_username: user.email })}` }
  assert.equal((await api('GET', '/api/linux/enrollments', { headers: userJwt })).statusCode, 403)
  assert.equal((await approve(key.id, { profile: 'field', ring: 'pilot' }, userJwt)).statusCode, 403)

  const list = await api('GET', '/api/linux/enrollments')
  assert.equal(list.statusCode, 200, list.body)
  const row = list.json().rows.find(r => r.id === key.id)
  assert.ok(row, 'demande visible dans la file')
  assert.equal(row.code, agent.code)
  assert.equal(row.fingerprint, agent.fingerprint)
  assert.equal(row.status, 'pending')
  assert.equal(row.serial_claimed, 'SN-FLOW-NEW')
  assert.equal(row.hostname_claimed, 'debian-new')
  assert.equal(row.conflict, null)
  assert.equal(row.preregistration, null)
  assert.equal(row.enroll_attempts, 1)
  assert.equal(row.public_key, undefined, 'clé publique jamais sérialisée')
  const count = await api('GET', '/api/linux/enrollments/count')
  assert.equal(count.statusCode, 200)
  assert.ok(count.json().pending >= 1)

  const approved = await approve(key.id, { profile: 'field', ring: 'pilot', assigned_user_id: 'oid-lx-user' })
  assert.equal(approved.statusCode, 200, approved.body)
  const detail = approved.json()
  assert.equal(detail.hostname, 'lx-sn-flow-new')
  assert.equal(detail.platform, 'linux')
  assert.equal(detail.managed_by, 'pull')
  assert.equal(detail.profile, 'field')
  assert.equal(detail.ring, 'pilot')
  assert.deepEqual(detail.assigned_user, { entra_id: 'oid-lx-user', display_name: 'Utilisateur Lx', email: 'lx.user@x' })
  assert.equal(detail.key.id, key.id)
  assert.equal(detail.key.status, 'approved')
  assert.equal(detail.key.fingerprint, agent.fingerprint)
  assert.equal(detail.key.approved_by, 'Admin Linux')
  assert.equal(detail.online, false)
  assert.equal(detail.converted_from_windows, false)
  assert.deepEqual(detail.recovery_keys, [])
  assert.equal(detail.laps, null)
  assert.equal(detail.last_report, null)
  assert.equal(detail.needs_escrow, false)
  // Miroir prêt : tête du ring et profil présent dans le dépôt ; tête trop récente pour un retard.
  assert.equal(detail.ring_tip, app.gitMirror.heads().pilot)
  assert.equal(detail.lagging, false)
  assert.equal(detail.profile_in_repo, true)
  for (const field of ['last_apply_status', 'last_apply_at', 'kernel', 'luks_root']) {
    assert.equal(detail[field], null, field)
  }
  const { rows: [device] } = await db.query('SELECT platform, managed_by, source FROM devices WHERE id = $1', [detail.id])
  assert.deepEqual(device, { platform: 'linux', managed_by: 'pull', source: 'agent' })
  const [audit] = await audits('linux_device_approved', detail.id)
  assert.equal(audit.by_user, 'Admin Linux')
  assert.equal(audit.details.key_id, key.id)

  const ok = await enroll(app, agent, { ip })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json(), { status: 'approved', device_id: detail.id, hostname: 'lx-sn-flow-new' })
  // Relance déjà traitée : 409 NOT_PENDING.
  const again = await approve(key.id, { profile: 'field', ring: 'pilot' })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'NOT_PENDING')
})

test('poste Windows de même série → 202 existing_device → conversion : CONFLICT, ACTIVE_TOKEN, puis faits effacés, token legacy 401, historique conservé', { skip: SKIP }, async () => {
  const win = await seedDevice(db, { hostname: 'PC-CONVERT-FLOW', serial: 'SN-CONV-FLOW', ipNetbird: '100.64.0.7' })
  await db.query(`UPDATE devices SET platform = 'windows', agent_version = '2.15.3', intune_device_id = 'intune-flow',
    health_signals = '{"a":1}', assigned_user_id = 'oid-lx-user' WHERE id = $1`, [win.id])
  await db.query("INSERT INTO disks (device_id, letter) VALUES ($1, 'C:')", [win.id])
  const { rows: [ticket] } = await db.query("INSERT INTO tickets (title, device_id) VALUES ('Écran cassé', $1) RETURNING id", [win.id])
  const { rows: [group] } = await db.query("INSERT INTO groups (name) VALUES ('Migration flow') RETURNING id")
  await db.query('INSERT INTO group_members (group_id, device_id) VALUES ($1, $2)', [group.id, win.id])
  const legacy = await seedAgentToken(db, { deviceId: win.id, label: 'legacy-flow' })
  await db.query('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1', [legacy.id])
  const legacyHeaders = { authorization: `Bearer ${legacy.secret}` }
  const before = await app.inject({ method: 'POST', url: '/api/agent/checkin', headers: legacyHeaders, payload: { hostname: 'PC-CONVERT-FLOW', serial: 'SN-CONV-FLOW' } })
  assert.equal(before.statusCode, 200, 'token legacy valide avant conversion')

  const agent = newAgent({ serial: 'sn-conv-flow', hostname: 'debian-conv' })
  const res = await enroll(app, agent, { ip: nextIp() })
  assert.equal(res.statusCode, 202, res.body)
  assert.equal(res.json().conflict.kind, 'existing_device')
  const key = await keyOf(agent)
  const list = await api('GET', '/api/linux/enrollments')
  const row = list.json().rows.find(r => r.id === key.id)
  assert.equal(row.conflict.device_id, win.id)
  assert.equal(row.conflict.hostname, 'PC-CONVERT-FLOW')
  assert.equal(row.conflict.has_active_token, true)
  const [conflict] = await audits('linux_enroll_serial_conflict', win.id)
  assert.equal(conflict.details.level, 'warn')

  const noTarget = await approve(key.id, { profile: 'field', ring: 'pilot' })
  assert.equal(noTarget.statusCode, 409, noTarget.body)
  assert.equal(noTarget.json().code, 'CONFLICT')
  const active = await approve(key.id, { profile: 'field', ring: 'pilot', convert_device_id: win.id })
  assert.equal(active.statusCode, 409, active.body)
  assert.equal(active.json().code, 'ACTIVE_TOKEN')
  assert.equal(active.json().details.token_id, legacy.id)

  const converted = await approve(key.id, { profile: 'field', ring: 'stable', convert_device_id: win.id, revoke_active_token: true })
  assert.equal(converted.statusCode, 200, converted.body)
  const detail = converted.json()
  assert.equal(detail.id, win.id, 'même ligne devices')
  assert.equal(detail.hostname, 'PC-CONVERT-FLOW', 'nom existant conservé')
  assert.equal(detail.platform, 'linux')
  assert.equal(detail.managed_by, 'pull')
  assert.equal(detail.ring, 'stable')
  assert.equal(detail.converted_from_windows, true)
  assert.equal(detail.assigned_user.entra_id, 'oid-lx-user', 'utilisateur existant conservé')
  assert.equal(detail.key.id, key.id)
  assert.deepEqual(evicted.at(-1), [win.id, 'converted-to-pull'], 'tube WS de l’agent Windows fermé après COMMIT')

  const { rows: [device] } = await db.query('SELECT agent_version, intune_device_id, health_signals, ip_netbird FROM devices WHERE id = $1', [win.id])
  assert.deepEqual(device, { agent_version: null, intune_device_id: null, health_signals: null, ip_netbird: null })
  assert.equal((await db.query('SELECT 1 FROM disks WHERE device_id = $1', [win.id])).rowCount, 0)
  const { rows: [tok] } = await db.query('SELECT revoked_at FROM agent_tokens WHERE id = $1', [legacy.id])
  assert.ok(tok.revoked_at, 'token legacy révoqué')
  const after = await app.inject({ method: 'POST', url: '/api/agent/checkin', headers: legacyHeaders, payload: { hostname: 'PC-CONVERT-FLOW', serial: 'SN-CONV-FLOW' } })
  assert.equal(after.statusCode, 401, 'token legacy refusé après conversion')
  const { rows: [t] } = await db.query('SELECT device_id FROM tickets WHERE id = $1', [ticket.id])
  assert.equal(t.device_id, win.id, 'ticket toujours rattaché')
  assert.equal((await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND device_id = $2', [group.id, win.id])).rowCount, 1)
  const [audit] = await audits('linux_device_converted', win.id)
  assert.equal(audit.by_user, 'Admin Linux')
  assert.equal(audit.details.cleared.disks, 1)
  assert.equal(audit.details.cleared.agent_tokens, 1)

  const ok = await enroll(app, agent, { ip: nextIp() })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().device_id, win.id)
})

test('ré-image d’un poste pull → 202 reimage → ACTIVE_KEY sans supersede → avec supersede : ancienne clé révoquée, nouvelle liée', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-reimage-flow', serial: 'SN-RE-FLOW', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const old = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-RE-FLOW' })
  const agent = newAgent({ serial: 'SN-RE-FLOW' })
  const res = await enroll(app, agent, { ip: nextIp() })
  assert.equal(res.statusCode, 202, res.body)
  assert.equal(res.json().conflict.kind, 'reimage')
  const key = await keyOf(agent)

  const refused = await approve(key.id, { profile: 'field', ring: 'pilot' })
  assert.equal(refused.statusCode, 409, refused.body)
  assert.equal(refused.json().code, 'ACTIVE_KEY')
  assert.equal(refused.json().details.old_key, old.id)
  assert.equal(refused.json().details.hostname, 'lx-reimage-flow')

  const ok = await approve(key.id, { profile: 'admin', ring: 'stable', supersede: true })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().id, pull.id)
  assert.equal(ok.json().hostname, 'lx-reimage-flow')
  assert.equal(ok.json().profile, 'admin')
  assert.equal(ok.json().key.id, key.id)
  assert.equal(ok.json().key.status, 'approved')
  const { rows: [previous] } = await db.query('SELECT status, revoke_reason FROM linux_device_keys WHERE id = $1', [old.id])
  assert.deepEqual(previous, { status: 'revoked', revoke_reason: 'superseded' })
  assert.equal((await audits('linux_device_reenrolled', pull.id)).length, 1)
  assert.equal((await enroll(app, agent, { ip: nextIp() })).statusCode, 200)
})

test('rejet → /enroll 403 rejected ; clé approuvée avec une autre série → 403 SERIAL_MISMATCH', { skip: SKIP }, async () => {
  const agent = newAgent({ serial: 'SN-REJ-FLOW' })
  const ip = nextIp()
  await enroll(app, agent, { ip })
  const key = await keyOf(agent)
  const rejected = await api('POST', `/api/linux/enrollments/${key.id}/reject`, { payload: { reason: 'matériel inconnu' } })
  assert.equal(rejected.statusCode, 200, rejected.body)
  assert.equal(rejected.json().status, 'rejected')
  assert.equal(rejected.json().rejected_by, 'Admin Linux')
  const res = await enroll(app, agent, { ip })
  assert.equal(res.statusCode, 403, res.body)
  assert.deepEqual(res.json(), { status: 'rejected', error: 'Enrôlement rejeté', code: 'REJECTED' })

  await db.query("INSERT INTO linux_preregistrations (serial, profile, ring, created_by) VALUES ('SN-MM-FLOW', 'field', 'pilot', 'test')")
  const approved = newAgent({ serial: 'SN-MM-FLOW' })
  assert.equal((await enroll(app, approved, { ip })).statusCode, 200)
  const mismatch = await enroll(app, approved, { ip, body: { serial: 'SN-OTHER-FLOW' } })
  assert.equal(mismatch.statusCode, 403, mismatch.body)
  assert.equal(mismatch.json().status, 'serial_mismatch')
  assert.equal(mismatch.json().code, 'SERIAL_MISMATCH')
})

test('token CLI : lecture de la file acceptée, approbation / rejet / révocation → 403 INTERACTIVE_ONLY', { skip: SKIP }, async () => {
  const agent = newAgent({ serial: 'SN-CLI-FLOW' })
  await enroll(app, agent, { ip: nextIp() })
  const key = await keyOf(agent)
  // Cible réelle pour la révocation : un poste pull avec sa clé approuvée.
  const pull = await seedDevice(db, { hostname: 'lx-cli-flow', serial: 'SN-CLI-DEV', platform: 'linux', managed_by: 'pull' })
  const approvedKey = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-CLI-DEV' })
  assert.equal((await api('GET', '/api/linux/enrollments', { headers: cli })).statusCode, 200)
  for (const [method, url, payload] of [
    ['POST', `/api/linux/enrollments/${key.id}/approve`, { profile: 'field', ring: 'pilot' }],
    ['POST', `/api/linux/enrollments/${key.id}/reject`, {}],
    ['POST', '/api/linux/enrollments/approve-bulk', { ids: [key.id], profile: 'field', ring: 'pilot' }],
    ['POST', '/api/linux/enrollments/reject-bulk', { ids: [key.id] }],
    ['POST', `/api/linux/devices/${pull.id}/revoke`, { reason: 'Poste volé' }],
  ]) {
    const res = await api(method, url, { headers: cli, payload })
    assert.equal(res.statusCode, 403, `${url}: ${res.body}`)
    assert.equal(res.json().code, 'INTERACTIVE_ONLY')
  }
  assert.equal((await keyOf(agent)).status, 'pending', 'aucune transition')
  const { rows: [stillApproved] } = await db.query('SELECT status FROM linux_device_keys WHERE id = $1', [approvedKey.id])
  assert.equal(stillApproved.status, 'approved', 'clé du poste pull intacte')
})

test('/enroll — signature exigée : sans en-têtes 401, empreinte différente de public_key 401, corps > 4 Kio 413', { skip: SKIP }, async () => {
  const agent = newAgent({ serial: 'SN-SIG-FLOW' })
  const bare = await app.inject({ method: 'POST', url: '/api/linux/agent/enroll', remoteAddress: nextIp(), payload: agent.body })
  assert.equal(bare.statusCode, 401)
  const other = newAgent({ serial: 'SN-SIG-FLOW' })
  const forged = await enroll(app, other, { ip: nextIp(), body: { public_key: agent.body.public_key } })
  assert.equal(forged.statusCode, 401, forged.body)
  assert.equal(forged.json().code, 'SIGNATURE_INVALID')
  assert.equal(await keyOf(agent), undefined, 'aucune ligne créée')
  const big = await enroll(app, agent, { ip: nextIp(), body: { hostname: 'x'.repeat(5000) } })
  assert.equal(big.statusCode, 413, big.body)
})

test('/enroll — limite 30/min par IP seule : la 31e relance est refusée, sans nouvelle ligne', { skip: SKIP }, async () => {
  const agent = newAgent({ serial: 'SN-RATE-FLOW' })
  const ip = nextIp()
  const statuses = []
  for (let i = 0; i < 31; i++) statuses.push((await enroll(app, agent, { ip })).statusCode)
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(202))
  assert.equal(statuses[30], 429)
  assert.equal((await keyOf(agent)).enroll_attempts, 30)
  // Autre IP : compteur distinct.
  assert.equal((await enroll(app, agent, { ip: nextIp() })).statusCode, 202)
})

test('plafond de file : 501e demande inconnue → 429 ENROLL_FLOOD audité ; une clé connue relance toujours', { skip: SKIP }, async () => {
  const known = newAgent({ serial: 'SN-KNOWN-FLOOD-FLOW' })
  const ip = nextIp()
  assert.equal((await enroll(app, known, { ip })).statusCode, 202)
  const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM linux_device_keys WHERE status = 'pending'")
  await db.query(`
    INSERT INTO linux_device_keys (key_fingerprint, public_key, key_backing, serial_claimed)
    SELECT md5('flow-a-' || i) || md5('flow-b-' || i), decode(md5('pk-a-' || i) || md5('pk-b-' || i), 'hex'), 'software', 'SN-FLOODFLOW-' || i
    FROM generate_series(1, $1) AS i
  `, [PENDING_CAP - n])
  const fresh = newAgent({ serial: 'SN-FLOOD-FLOW-NEW' })
  const res = await enroll(app, fresh, { ip })
  assert.equal(res.statusCode, 429, res.body)
  assert.deepEqual(res.json(), { error: 'File d’enrôlement pleine, réessayer plus tard', code: 'ENROLL_FLOOD', retry_after_ms: 300_000 })
  assert.equal(res.headers['retry-after'], '300')
  assert.equal(await keyOf(fresh), undefined, 'aucune ligne créée')
  const { rows: [flood] } = await db.query("SELECT by_user, details FROM audit_logs WHERE action = 'linux_enroll_flood' ORDER BY created_at DESC LIMIT 1")
  assert.equal(flood.by_user, 'device:' + fresh.fingerprint.slice(0, 12))
  assert.equal(flood.details.level, 'error')
  assert.equal((await enroll(app, known, { ip })).statusCode, 202, 'clé connue jamais bloquée')
  await db.query("DELETE FROM linux_device_keys WHERE serial_claimed LIKE 'SN-FLOODFLOW-%'")
})

test('cycle d’application : check-in → rapport failed (linux_apply_failed) → rapport success (linux_apply_recovered) → détail avec last_report et last_successful_revision', { skip: SKIP }, async () => {
  const pull = await seedDevice(db, { hostname: 'lx-apply-flow', serial: 'SN-APPLY-FLOW', platform: 'linux', managed_by: 'pull', profile: 'field', ring: 'pilot' })
  const key = await seedLinuxDeviceKey(db, { deviceId: pull.id, status: 'approved', serialClaimed: 'SN-APPLY-FLOW' })
  const agent = { privateKey: key.privateKey, fingerprint: key.fingerprint, body: { serial: 'SN-APPLY-FLOW', hostname: 'lx-apply-flow', os_version: 'Debian GNU/Linux 12 (bookworm)', agent_version: '0.1.0' } }
  const ip = nextIp()
  const assigned = await checkin(app, agent, { ip })
  assert.equal(assigned.statusCode, 200, assigned.body)
  const { revision } = assigned.json()
  assert.equal(revision, app.gitMirror.heads().pilot, 'tête réelle du ring pilot')

  const failed = await report(app, agent, { ip, body: { revision, status: 'failed', error_summary: 'TASK [base] — apt: Unable to locate package foo', log_tail: 'PLAY [localhost] ***\nfatal: …' } })
  assert.equal(failed.statusCode, 201, failed.body)
  assert.equal(failed.json().transition, 'failed')
  const [fail] = await audits('linux_apply_failed', pull.id)
  assert.equal(fail.by_user, 'device:' + agent.fingerprint.slice(0, 12))
  assert.deepEqual(fail.details, { level: 'error', revision, hostname: 'lx-apply-flow', error_summary: 'TASK [base] — apt: Unable to locate package foo' })

  const ok = await report(app, agent, { ip, body: { revision, status: 'success' } })
  assert.equal(ok.statusCode, 201, ok.body)
  assert.equal(ok.json().transition, 'recovered')
  assert.equal((await audits('linux_apply_recovered', pull.id)).length, 1)

  const detail = await api('GET', `/api/linux/devices/${pull.id}`)
  assert.equal(detail.statusCode, 200, detail.body)
  const d = detail.json()
  assert.deepEqual([d.last_revision_applied, d.last_successful_revision, d.last_apply_status, d.lagging], [revision, revision, 'success', false])
  assert.equal(d.last_report.id, ok.json().id, 'rapport le plus récent')
  assert.deepEqual([d.last_report.status, d.last_report.revision, d.last_report.log_tail], ['success', revision, null])
  const history = await api('GET', `/api/linux/devices/${pull.id}/reports`)
  assert.deepEqual(history.json().rows.map(r => [r.status, r.error_summary]), [['success', null], ['failed', 'TASK [base] — apt: Unable to locate package foo']])
})
