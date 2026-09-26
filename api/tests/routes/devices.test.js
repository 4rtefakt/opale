// routes/devices.js : GET / (liste avec filtres + computeStatus) + GET /:id
// + DELETE /:id. La fonction computeStatus n'est pas exportée — on la teste
// indirectement via le champ `status` retourné par GET / et formatDevice().
//
// Focus PR8 :
//   - Auth admin sur les opérations sensibles (DELETE notamment)
//   - Filtres status (online / offline / critical / unassigned) côté SQL
//   - computeStatus : transitions selon last_seen + disk_used_pct
//   - Thresholds depuis settings (disk_warn_pct, disk_critical_pct) avec
//     defaults 80/90 si absents
//
// Hors scope :
//   - POST /force-sync (touche Microsoft Graph via syncIntuneDevice)
//   - POST /force-checkin (push notif au tube agent)
//   - GET /:id/remote-sessions (ré-utilise routes/remote-sessions.js)

import { test, before, after } from 'node:test'
import net from 'node:net'
import ssh2 from 'ssh2'
import assert from 'node:assert/strict'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import devicesRoute from '../../modules/inventory/routes/devices.js'
import { startFakeSshServer, sshClientEnv, trackUnhandledRejections } from '../helpers/fake-ssh.js'

const sshUtils = ssh2.utils

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify, jwt
let prevEnv = {}

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()

  fastify = await buildApp({
    db,
    jwks: jwt.jwks,
    routes: async (f) => {
      await f.register(devicesRoute, { prefix: '/api/devices' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

async function adminAuth(entraId = 'oid-dev-admin') {
  const a = await seedAdmin(db, { entraId })
  return { user: a, token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }) }
}

// Crée un device avec last_seen + disk_used_pct contrôlés pour exercer
// computeStatus.
async function insertDevice({ hostname, lastSeenMinutesAgo = 0, diskUsedPct = null, assignedUserId = null }) {
  const last = new Date(Date.now() - lastSeenMinutesAgo * 60_000).toISOString()
  const r = await db.query(
    `INSERT INTO devices (hostname, last_seen, disk_used_pct, assigned_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [hostname, last, diskUsedPct, assignedUserId]
  )
  return r.rows[0].id
}

// ─── Auth ───────────────────────────────────────────────────────────────────

test('GET / — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/devices/' })
  assert.equal(res.statusCode, 401)
})

test('GET /:id — non-admin → 403', { skip: SKIP }, async () => {
  // GET /:id est admin-only (retourne des données détaillées sensibles).
  // GET /  (liste) l'est aussi (cf. test suivant).
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-na' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const deviceId = await insertDevice({ hostname: 'PC-X' })
  const res = await fastify.inject({
    method: 'GET', url: `/api/devices/${deviceId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('GET / — non-admin → 403 (liste des postes réservée aux admins)', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-list-na' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  await insertDevice({ hostname: 'PC-LIST-NA' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
  assert.doesNotMatch(res.body, /PC-LIST-NA/)
})

// ─── GET / — structure et thresholds ────────────────────────────────────────

test('GET / — structure : { devices, total, limit, offset, thresholds }', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-struct')
  await insertDevice({ hostname: 'PC-LIST-1' })
  await insertDevice({ hostname: 'PC-LIST-2' })

  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(Array.isArray(body.devices))
  assert.equal(typeof body.total, 'number')
  assert.equal(body.limit, 100)
  assert.equal(body.offset, 0)
  // thresholds par défaut 80/90 quand settings absents.
  assert.equal(body.thresholds.warn, 80)
  assert.equal(body.thresholds.critical, 90)
})

test('GET / — thresholds lus depuis settings quand présents', { skip: SKIP }, async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('disk_warn_pct', '70'), ('disk_critical_pct', '95')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  )
  try {
    const { token } = await adminAuth('oid-dev-thr')
    const res = await fastify.inject({
      method: 'GET', url: '/api/devices/',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.json().thresholds.warn, 70)
    assert.equal(res.json().thresholds.critical, 95)
  } finally {
    await db.query(`DELETE FROM settings WHERE key IN ('disk_warn_pct', 'disk_critical_pct')`)
  }
})

// ─── computeStatus (testée via le champ `status` de devices[]) ─────────────

test('computeStatus — last_seen null → offline', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-status-null')
  // Insert sans last_seen.
  await db.query(`INSERT INTO devices (hostname, last_seen) VALUES ('PC-NEVER-SEEN', NULL)`)
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=PC-NEVER-SEEN',
    headers: { authorization: `Bearer ${token}` },
  })
  const d = res.json().devices.find(x => x.hostname === 'PC-NEVER-SEEN')
  assert.equal(d.status, 'offline', 'sans last_seen → offline')
})

test('computeStatus — last_seen > 1h → offline', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-status-old')
  await insertDevice({ hostname: 'PC-OLD', lastSeenMinutesAgo: 120, diskUsedPct: 50 })
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=PC-OLD',
    headers: { authorization: `Bearer ${token}` },
  })
  const d = res.json().devices.find(x => x.hostname === 'PC-OLD')
  assert.equal(d.status, 'offline')
})

test('computeStatus — last_seen < 1h + disk 50% → online', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-status-online')
  await insertDevice({ hostname: 'PC-ONLINE', lastSeenMinutesAgo: 5, diskUsedPct: 50 })
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=PC-ONLINE',
    headers: { authorization: `Bearer ${token}` },
  })
  const d = res.json().devices.find(x => x.hostname === 'PC-ONLINE')
  assert.equal(d.status, 'online')
})

test('computeStatus — disk >= critical (90) → critical (override de online)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-status-crit')
  await insertDevice({ hostname: 'PC-CRIT', lastSeenMinutesAgo: 5, diskUsedPct: 95 })
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=PC-CRIT',
    headers: { authorization: `Bearer ${token}` },
  })
  const d = res.json().devices.find(x => x.hostname === 'PC-CRIT')
  assert.equal(d.status, 'critical', 'disk ≥ 90 prime même si online')
})

test('computeStatus — disk entre warn (80) et critical (90) → warn', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-status-warn')
  await insertDevice({ hostname: 'PC-WARN', lastSeenMinutesAgo: 5, diskUsedPct: 85 })
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=PC-WARN',
    headers: { authorization: `Bearer ${token}` },
  })
  const d = res.json().devices.find(x => x.hostname === 'PC-WARN')
  assert.equal(d.status, 'warn')
})

// ─── GET / — filtres status / search / unassigned ──────────────────────────

test('GET /?status=online — retourne UNIQUEMENT les devices online', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-filt-online')
  await insertDevice({ hostname: 'PC-FILT-ON',  lastSeenMinutesAgo: 5,   diskUsedPct: 50 })
  await insertDevice({ hostname: 'PC-FILT-OFF', lastSeenMinutesAgo: 120, diskUsedPct: 50 })

  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?status=online',
    headers: { authorization: `Bearer ${token}` },
  })
  const hostnames = res.json().devices.map(d => d.hostname)
  assert.ok(hostnames.includes('PC-FILT-ON'))
  assert.ok(!hostnames.includes('PC-FILT-OFF'))
})

test('GET /?status=critical — filtre disk >= critical (90%)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-filt-crit')
  await insertDevice({ hostname: 'PC-FILT-C-OK',  lastSeenMinutesAgo: 5, diskUsedPct: 50 })
  await insertDevice({ hostname: 'PC-FILT-C-BAD', lastSeenMinutesAgo: 5, diskUsedPct: 95 })

  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?status=critical',
    headers: { authorization: `Bearer ${token}` },
  })
  const hostnames = res.json().devices.map(d => d.hostname)
  assert.ok(hostnames.includes('PC-FILT-C-BAD'))
  assert.ok(!hostnames.includes('PC-FILT-C-OK'))
})

test('GET /?status=unassigned — filtre assigned_user_id IS NULL', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-filt-noassign')
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-assigned' })
  await insertDevice({ hostname: 'PC-FILT-ASSIGNED',   assignedUserId: u.entraId })
  await insertDevice({ hostname: 'PC-FILT-UNASSIGNED', assignedUserId: null })

  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?status=unassigned',
    headers: { authorization: `Bearer ${token}` },
  })
  const hostnames = res.json().devices.map(d => d.hostname)
  assert.ok(hostnames.includes('PC-FILT-UNASSIGNED'))
  assert.ok(!hostnames.includes('PC-FILT-ASSIGNED'))
})

test('GET /?search=... — match ILIKE sur hostname, email, display_name, model', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-search')
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-search-user', displayName: 'Findable User', email: 'findable@x' })
  await insertDevice({ hostname: 'PC-FIND-A', assignedUserId: u.entraId })
  await insertDevice({ hostname: 'PC-OTHER-B' })

  // Search par display_name de l'utilisateur assigné.
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/?search=Findable',
    headers: { authorization: `Bearer ${token}` },
  })
  const hostnames = res.json().devices.map(d => d.hostname)
  assert.ok(hostnames.includes('PC-FIND-A'))
  assert.ok(!hostnames.includes('PC-OTHER-B'))
})

// ─── GET /:id — détail ──────────────────────────────────────────────────────

test('GET /:id — 404 sur id inconnu', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-id-404')
  const res = await fastify.inject({
    method: 'GET', url: '/api/devices/00000000-0000-0000-0000-000000000000',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — admin OK retourne le device complet', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-id-ok')
  const deviceId = await insertDevice({ hostname: 'PC-DETAIL', lastSeenMinutesAgo: 5, diskUsedPct: 60 })
  const res = await fastify.inject({
    method: 'GET', url: `/api/devices/${deviceId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.hostname, 'PC-DETAIL')
  assert.equal(body.status, 'online')
})

// ─── DELETE /:id — admin-only ──────────────────────────────────────────────

test('DELETE /:id — non-admin → 403', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-del-na' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const deviceId = await insertDevice({ hostname: 'PC-DEL-PROTECTED' })
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${deviceId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('DELETE /:id — admin happy path : supprime + audit_logs device_deleted', { skip: SKIP }, async () => {
  const { user, token } = await adminAuth('oid-dev-del-ok', 'Deleter Admin')
  const deviceId = await insertDevice({ hostname: 'PC-TO-DELETE' })

  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${deviceId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.ok([200, 204].includes(res.statusCode), `expected 200/204, got ${res.statusCode}`)

  const { rows } = await db.query(`SELECT id FROM devices WHERE id = $1`, [deviceId])
  assert.equal(rows.length, 0, 'device doit avoir été supprimé')

  const { rows: audits } = await db.query(
    `SELECT by_user, target FROM audit_logs WHERE action = 'device_deleted'`
  )
  assert.ok(audits.length >= 1)
  assert.equal(audits[0].by_user, user.displayName)
})

// ip_netbird est remonté par l'agent : pas de SSH vers un nom d'hôte.
test('POST /force-checkin — ip_netbird qui n\'est pas une IP → poste ignoré, aucune connexion SSH', { skip: SKIP }, async (t) => {
  // Clé SSH valide et port local fermé : sans la validation, la route
  // tenterait une connexion vers « localhost » (erreur ECONNREFUSED
  // rapportée dans `errors`), au lieu d'ignorer le poste.
  let key
  for (let i = 0; i < 20 && !key; i++) {
    const k = sshUtils.generateKeyPairSync('ed25519')
    if (!(sshUtils.parseKey(k.private) instanceof Error)) key = k
  }
  const closedPort = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const saved = { SSH_PRIVATE_KEY_B64: process.env.SSH_PRIVATE_KEY_B64, SSH_PORT: process.env.SSH_PORT }
  process.env.SSH_PRIVATE_KEY_B64 = Buffer.from(key.private).toString('base64')
  process.env.SSH_PORT = String(closedPort)
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  const { token } = await adminAuth('oid-dev-force-bad-ip')
  const id = await insertDevice({ hostname: 'PC-FORCE-BADIP' })
  await db.query(`UPDATE devices SET ip_netbird = 'localhost' WHERE id = $1`, [id])

  const res = await fastify.inject({
    method: 'POST', url: '/api/devices/force-checkin',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [id] },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: 0, skipped: 1, errors: [] })
})

// ─── Clé d'hôte SSH (TOFU) ──────────────────────────────────────────────────

test('POST /force-checkin — clé d\'hôte SSH différente de l\'empreinte connue → refus explicite, aucune commande', { skip: SKIP, timeout: 20000 }, async (t) => {
  const impostor = await startFakeSshServer(t, { output: 'restarted: Opale-Agent' })
  sshClientEnv(t, impostor.port)
  const { token } = await adminAuth('oid-dev-force-hostkey')
  const id = await insertDevice({ hostname: 'PC-FORCE-HOSTKEY' })
  await db.query(`UPDATE devices SET ip_netbird = '127.0.0.1', ssh_host_key_fp = 'empreinte-connue' WHERE id = $1`, [id])

  const res = await fastify.inject({
    method: 'POST', url: '/api/devices/force-checkin',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [id] },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, 0)
  assert.equal(body.errors.length, 1, JSON.stringify(body.errors))
  assert.match(body.errors[0], /Clé d'hôte SSH inattendue/)
  assert.equal(impostor.state.execs, 0)
})

test('POST /force-checkin — premier contact : empreinte apprise après authentification, commande exécutée', { skip: SKIP, timeout: 20000 }, async (t) => {
  const server = await startFakeSshServer(t, { output: 'restarted: Opale-Agent' })
  sshClientEnv(t, server.port)
  const { token } = await adminAuth('oid-dev-force-hostkey-learn')
  const id = await insertDevice({ hostname: 'PC-FORCE-LEARN' })
  await db.query(`UPDATE devices SET ip_netbird = '127.0.0.1' WHERE id = $1`, [id])

  const res = await fastify.inject({
    method: 'POST', url: '/api/devices/force-checkin',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [id] },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: 1, skipped: 0, errors: [] })
  assert.equal(server.state.execs, 1)
  const { rows: [d] } = await db.query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [id])
  assert.ok(d.ssh_host_key_fp, 'empreinte mémorisée au premier contact')
})

test('POST /force-checkin — hôte qui refuse la clé d\'Opale : son empreinte n\'est PAS épinglée', { skip: SKIP, timeout: 20000 }, async (t) => {
  // IP Netbird réattribuée à un autre pair : l'épingler bloquerait le vrai
  // poste jusqu'à une réinitialisation manuelle.
  const stranger = await startFakeSshServer(t, { rejectAuth: true })
  sshClientEnv(t, stranger.port)
  const { token } = await adminAuth('oid-dev-force-hostkey-noauth')
  const id = await insertDevice({ hostname: 'PC-FORCE-NOAUTH' })
  await db.query(`UPDATE devices SET ip_netbird = '127.0.0.1' WHERE id = $1`, [id])

  const res = await fastify.inject({
    method: 'POST', url: '/api/devices/force-checkin',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [id] },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, 0)
  assert.equal(res.json().errors.length, 1)
  assert.equal(stranger.state.execs, 0)
  const { rows: [d] } = await db.query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [id])
  assert.equal(d.ssh_host_key_fp, null)
  const { rows: audits } = await db.query(
    `SELECT 1 FROM audit_logs WHERE action = 'ssh_host_key_learned' AND target = $1`, [id]
  )
  assert.equal(audits.length, 0)
})

test('POST /force-checkin — hôte qui raccroche après authentification : erreur rapportée, API intacte', { skip: SKIP, timeout: 20000 }, async (t) => {
  const rejections = trackUnhandledRejections(t)
  const server = await startFakeSshServer(t, { endOnReady: true })
  sshClientEnv(t, server.port)
  const { token } = await adminAuth('oid-dev-force-hostkey-hangup')
  const id = await insertDevice({ hostname: 'PC-FORCE-HANGUP' })
  await db.query(`UPDATE devices SET ip_netbird = '127.0.0.1' WHERE id = $1`, [id])

  const t0 = Date.now()
  const res = await fastify.inject({
    method: 'POST', url: '/api/devices/force-checkin',
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [id] },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, 0)
  assert.equal(res.json().errors.length, 1, JSON.stringify(res.json().errors))
  assert.doesNotMatch(res.json().errors[0], /timeout/)
  assert.ok(Date.now() - t0 < 10000, 'pas d\'attente du timeout de 15 s')
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(rejections, [])
})

test('DELETE /:id/ssh-host-key — non-admin → 403, empreinte conservée', { skip: SKIP }, async () => {
  const u = await seedNonAdmin(db, { entraId: 'oid-dev-hostkey-na' })
  const token = await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email })
  const id = await insertDevice({ hostname: 'PC-HOSTKEY-NA' })
  await db.query(`UPDATE devices SET ssh_host_key_fp = 'empreinte-na' WHERE id = $1`, [id])
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${id}/ssh-host-key`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
  const { rows: [d] } = await db.query(`SELECT ssh_host_key_fp FROM devices WHERE id = $1`, [id])
  assert.equal(d.ssh_host_key_fp, 'empreinte-na')
})

test('DELETE /:id/ssh-host-key — admin → 204, empreinte effacée, action auditée', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-hostkey-admin')
  const id = await insertDevice({ hostname: 'PC-HOSTKEY-RESET' })
  await db.query(`UPDATE devices SET ssh_host_key_fp = 'empreinte-avant', ssh_host_key_learned_at = now() WHERE id = $1`, [id])
  const res = await fastify.inject({
    method: 'DELETE', url: `/api/devices/${id}/ssh-host-key`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 204)
  const { rows: [d] } = await db.query(`SELECT ssh_host_key_fp, ssh_host_key_learned_at FROM devices WHERE id = $1`, [id])
  assert.equal(d.ssh_host_key_fp, null)
  assert.equal(d.ssh_host_key_learned_at, null)
  const { rows: audit } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'ssh_host_key_reset' AND target = $1`, [id])
  assert.equal(audit.length, 1)
  assert.equal(audit[0].details.previous_fingerprint, 'empreinte-avant')
  assert.equal(audit[0].details.hostname, 'PC-HOSTKEY-RESET')
  assert.equal(audit[0].details.level, 'warn')
})

test('DELETE /:id/ssh-host-key — poste inconnu → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-hostkey-404')
  const res = await fastify.inject({
    method: 'DELETE', url: '/api/devices/00000000-0000-0000-0000-000000000000/ssh-host-key',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('GET /:id — expose l\'empreinte d\'hôte SSH apprise (fiche du poste)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-dev-hostkey-get')
  const id = await insertDevice({ hostname: 'PC-HOSTKEY-GET' })
  await db.query(`UPDATE devices SET ssh_host_key_fp = 'empreinte-fiche', ssh_host_key_learned_at = now() WHERE id = $1`, [id])
  const res = await fastify.inject({ method: 'GET', url: `/api/devices/${id}`, headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ssh_host_key_fp, 'empreinte-fiche')
  assert.ok(res.json().ssh_host_key_learned_at)
  assert.equal(res.json().ssh_host_key_policy, 'tofu')
})
