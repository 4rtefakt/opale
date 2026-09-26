// routes/agent.js : endpoints HTTP utilisés par l'agent Go.
//
// Périmètre testé en PR4 :
//   - POST /api/agent/checkin     : auth token agent, validation,
//                                   anti cross-device, hook compliance
//   - POST /api/agent/exchange-token : bootstrap → token persistant
//                                      (avec quota bootstrap_max_redeems)
//   - POST /api/agent/rotate-token : rotation (nouveau token + ancien
//                                    avec expires_at + replaced_by)
//   - GET  /api/agent/version       : version sidecar
//
// Hors scope PR4 :
//   - WS /api/agent/ws (vrai client WS + agentWs registry + dispatcher
//     console.* hors scope unit, registry déjà testé en PR1)
//   - GET /api/agent/binary[/meta] (touche au filesystem dist/, signing
//     ed25519 → couvert en intégration plus large quand binaire dispo)
//   - POST /api/agent/admin-credential (LAPS escrow chiffré RSA-OAEP)
//   - POST /api/agent/result, /setup-log, /runtime-config (annexes,
//     pattern auth identique à /version donc couverture sécu déjà
//     extrapolable)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedAgentToken } from '../fixtures/agent-tokens.js'
import { insertPackage, insertDeployment } from '../fixtures/packages.js'

import agentRoute from '../../modules/inventory/routes/agent.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let schema, db, release, fastify

before(async () => {
  if (!isDbAvailable()) return
  // VAPID désarmé → sendPushToAll early-return.
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY

  const acquired = await acquireSchema()
  schema = acquired.schema; db = acquired.db; release = acquired.release

  fastify = await buildApp({
    db,
    registerAuth: false, // les routes agent utilisent leur propre authToken
    routes: async (f) => {
      await f.register(agentRoute, { prefix: '/api/agent' })
    },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
})

function bearer(secret) {
  return { authorization: `Bearer ${secret}` }
}

// ─── POST /checkin — authentification ───────────────────────────────────────

test('POST /checkin — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    payload: { hostname: 'PC-X' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /checkin — token inconnu → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer('a'.repeat(64)),
    payload: { hostname: 'PC-X' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /checkin — token révoqué → 401', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-REVOKED' })
  const { secret } = await seedAgentToken(db, {
    deviceId: device.id,
    label: 'revoked',
    revokedAt: new Date().toISOString(),
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /checkin — token expiré (rotation grace passée) → 401', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-EXPIRED' })
  const { secret } = await seedAgentToken(db, {
    deviceId: device.id,
    label: 'expired',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 401)
})

test('bootstrap token refusé sur toutes les routes agent authentifiées → 401', { skip: SKIP }, async () => {
  // Sécu : le bootstrap (partagé par toute la flotte via Intune) ne sert qu'à
  // /exchange-token. Avant : il passait authToken → checkin comme n'importe
  // quel hostname (et se liait au device), ou /rotate-token → token perso
  // non lié réutilisable pour usurper un poste.
  const device = await seedDevice(db, { hostname: 'PC-BOOTSTRAP-TARGET' })
  const bootstrap = await seedAgentToken(db, {
    label: 'bootstrap-authtoken',
    isBootstrap: true,
    bootstrapMaxRedeems: 100,
  })
  const calls = [
    { method: 'POST', url: '/api/agent/checkin',          payload: { hostname: device.hostname } },
    { method: 'POST', url: '/api/agent/rotate-token' },
    { method: 'POST', url: '/api/agent/result',           payload: { execution_id: '00000000-0000-0000-0000-000000000000', exit_code: 0 } },
    { method: 'POST', url: '/api/agent/admin-credential', payload: { username: 'x', encrypted_password: 'x' } },
    { method: 'GET',  url: '/api/agent/version' },
    { method: 'GET',  url: '/api/agent/runtime-config' },
    { method: 'GET',  url: '/api/agent/binary/meta?arch=amd64' },
    { method: 'GET',  url: '/api/agent/binary?arch=amd64' },
  ]
  for (const c of calls) {
    const res = await fastify.inject({ ...c, headers: bearer(bootstrap.secret) })
    assert.equal(res.statusCode, 401, `${c.method} ${c.url} → ${res.statusCode} ${res.body}`)
  }

  // Aucun effet de bord : le bootstrap reste non lié, aucun token créé.
  const { rows: [bs] } = await db.query(
    `SELECT device_id, last_used_at FROM agent_tokens WHERE id = $1`, [bootstrap.id]
  )
  assert.equal(bs.device_id, null)
  assert.equal(bs.last_used_at, null)
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM agent_tokens WHERE created_by = 'agent-rotation' AND device_id IS NULL`
  )
  assert.equal(n, 0)
})

// ─── POST /checkin — validation body ────────────────────────────────────────

test('POST /checkin — hostname manquant → 400', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-VAL' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: {},
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /hostname/)
})

// ─── POST /checkin — anti cross-device spoofing ─────────────────────────────

test('POST /checkin — token lié à device A + body hostname → device B = 403', { skip: SKIP }, async () => {
  // Sécu critique : un agent compromis ne doit pas pouvoir poster un
  // checkin pour un AUTRE device en spoofant le hostname dans le body.
  // Le check fait avant tout UPDATE pour ne pas polluer l'état de l'autre.
  const deviceA = await seedDevice(db, { hostname: 'PC-A' })
  const deviceB = await seedDevice(db, { hostname: 'PC-B' })
  const { secret } = await seedAgentToken(db, { deviceId: deviceA.id, label: 'token-of-A' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: deviceB.hostname }, // spoof
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /autre device/i)
})

// ─── POST /checkin — happy path + hook compliance ───────────────────────────

test('POST /checkin — premier checkin met à jour last_seen + déclenche eval compliance', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-HAPPY', lastSeenMinutesAgo: 60 })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })

  // Note last_seen avant le checkin pour comparer.
  const { rows: before } = await db.query(
    `SELECT last_seen FROM devices WHERE id = $1`, [device.id]
  )
  const lastSeenBefore = new Date(before[0].last_seen).getTime()

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: {
      hostname: device.hostname,
      health: {
        bitlocker: { volume: 'C:', protection_status: 'on' },
        defender: {
          antivirus_enabled: true, realtime_protection: true,
          signature_age_days: 1, threats_last_30d: 0,
        },
        firewall: { domain_enabled: true, private_enabled: true, public_enabled: true },
        last_windows_update: new Date().toISOString().slice(0, 10),
        pending_reboot: false,
      },
    },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)

  const { rows: after } = await db.query(
    `SELECT last_seen FROM devices WHERE id = $1`, [device.id]
  )
  const lastSeenAfter = new Date(after[0].last_seen).getTime()
  assert.ok(lastSeenAfter > lastSeenBefore, 'last_seen doit être bumped')

  // Hook compliance : 12 rows compliance_results créées.
  const { rows: comp } = await db.query(
    `SELECT count(*)::int AS n FROM compliance_results WHERE device_id = $1`,
    [device.id]
  )
  assert.equal(comp[0].n, 12, '12 compliance_results attendues (1 par règle)')
})

// ─── POST /checkin — fallback hostname (bug fix PR #93) ─────────────────────

test('POST /checkin — lookup serial 0 row → fallback hostname résout sans conflit', { skip: SKIP }, async () => {
  // Bug pre-existing résolu par PR #93 (commit 92ac023, déployé 2026-05-12) :
  // un device créé par sync Intune sans serial agent, puis l'agent checkin
  // avec son propre serial → lookup-par-serial → 0 row → branche INSERT
  // → unique constraint sur hostname → checkin échoue en boucle.
  // Fix : fallback hostname si lookup-par-serial vide. Ce test l'exerce.
  const device = await seedDevice(db, { hostname: 'PC-FALLBACK' })
  // device sans serial. Le token est lié au device existant.
  const { secret } = await seedAgentToken(db, { deviceId: device.id })

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: {
      hostname: 'PC-FALLBACK',
      serial: 'NEW-SERIAL-FROM-AGENT', // serial que la sync Intune n'avait pas
    },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)

  // Un seul row devices pour PC-FALLBACK — pas de duplication.
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM devices WHERE hostname = 'PC-FALLBACK'`
  )
  assert.equal(rows[0].n, 1, 'pas de duplication, fallback a fait UPDATE')
})

// ─── POST /checkin — distribution des déploiements ─────────────────────────

// Package script avec un install_script donné (insertPackage ne gère que winget).
async function insertScriptPackage(db, { name, status, installScript }) {
  const pkg = await insertPackage(db, { name, type: 'script', wingetId: null, status })
  await db.query(`UPDATE packages SET install_script = $1 WHERE id = $2`, [installScript, pkg.id])
  return pkg
}

// Déploiement pending + snapshot du contenu courant du package, comme le
// fait POST /api/packages/:id/deploy (cf. lib/deployment-snapshots.js).
async function insertSnapshottedDeployment(db, { packageId, deviceId }) {
  const dep = await insertDeployment(db, { packageId, deviceId })
  await db.query(`
    INSERT INTO deployment_snapshots (deployment_id, name, type, winget_id, install_script, post_install_script, detection_script)
    SELECT $1, p.name, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script
    FROM packages p WHERE p.id = $2
  `, [dep.id, packageId])
  return dep
}

test('POST /checkin — un déploiement pending d\'un package draft n\'est pas distribué', { skip: SKIP }, async () => {
  // Sécu : un package repassé en draft (modifié, non ré-approuvé) ne doit
  // jamais partir en SYSTEM sur un poste. Le déploiement reste pending.
  const device = await seedDevice(db, { hostname: 'PC-DEP-DRAFT' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const draft = await insertScriptPackage(db, {
    name: 'Pkg Draft Dispatch', status: 'draft', installScript: 'Write-Output draft',
  })
  const dep = await insertDeployment(db, { packageId: draft.id, deviceId: device.id })

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.deepEqual(res.json().deployments, [])

  const { rows: [row] } = await db.query(`SELECT status FROM deployments WHERE id = $1`, [dep.id])
  assert.equal(row.status, 'pending', 'le déploiement reste en attente de ré-approbation')
})

test('POST /checkin — un déploiement pending d\'un package approuvé est distribué (format inchangé)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-DEP-OK' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertScriptPackage(db, {
    name: 'Pkg Approved Dispatch', status: 'approved', installScript: 'Write-Output ok',
  })
  const dep = await insertSnapshottedDeployment(db, { packageId: pkg.id, deviceId: device.id })

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const deps = res.json().deployments
  assert.equal(deps.length, 1)
  // Forme exacte attendue par les agents déployés (agent-go/types.go Deployment).
  assert.deepEqual(Object.keys(deps[0]).sort(), [
    'deployment_id', 'detection_script', 'install_script', 'name',
    'post_install_script', 'type', 'winget_id',
  ])
  assert.equal(deps[0].deployment_id, dep.id)
  assert.equal(deps[0].install_script, 'Write-Output ok')

  const { rows: [row] } = await db.query(`SELECT status FROM deployments WHERE id = $1`, [dep.id])
  assert.equal(row.status, 'running')
})

test('POST /checkin — envoie le contenu figé du snapshot, pas le contenu courant du package', { skip: SKIP }, async () => {
  // Sécu : le contenu parti en SYSTEM est celui figé à la mise en file,
  // même si `packages` est modifié ensuite sans repasser par l'approbation.
  const device = await seedDevice(db, { hostname: 'PC-DEP-SNAP' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertScriptPackage(db, {
    name: 'Pkg Snapshot', status: 'approved', installScript: 'Write-Output v1',
  })
  const dep = await insertSnapshottedDeployment(db, { packageId: pkg.id, deviceId: device.id })
  await db.query(
    `UPDATE packages SET install_script = 'Write-Output pwned', detection_script = 'exit 0', name = 'Renamed' WHERE id = $1`,
    [pkg.id]
  )

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const deps = res.json().deployments
  assert.equal(deps.length, 1)
  assert.equal(deps[0].deployment_id, dep.id)
  assert.equal(deps[0].install_script, 'Write-Output v1')
  assert.equal(deps[0].detection_script, null)
  assert.equal(deps[0].name, 'Pkg Snapshot')
})

test('POST /checkin — un pending sans snapshot n\'est pas distribué (reste pending)', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-DEP-NOSNAP' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const pkg = await insertScriptPackage(db, {
    name: 'Pkg No Snapshot', status: 'approved', installScript: 'Write-Output legacy',
  })
  // Ligne créée hors API (ou par l'ancien code) : pas de snapshot.
  const orphan = await insertDeployment(db, { packageId: pkg.id, deviceId: device.id })
  const other = await insertScriptPackage(db, {
    name: 'Pkg With Snapshot', status: 'approved', installScript: 'Write-Output ok',
  })
  const good = await insertSnapshottedDeployment(db, { packageId: other.id, deviceId: device.id })

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.deepEqual(res.json().deployments.map(d => d.deployment_id), [good.id])

  const { rows: [row] } = await db.query(`SELECT status FROM deployments WHERE id = $1`, [orphan.id])
  assert.equal(row.status, 'pending')
})

test('POST /checkin — fan-out d\'un job : snapshot créé, package draft ignoré', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-DEP-FANOUT' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const approved = await insertScriptPackage(db, {
    name: 'Pkg Fanout Approved', status: 'approved', installScript: 'Write-Output fanout',
  })
  const draft = await insertScriptPackage(db, {
    name: 'Pkg Fanout Draft', status: 'draft', installScript: 'Write-Output draft',
  })
  await db.query(
    `INSERT INTO deployment_jobs (package_id, scope) VALUES ($1, 'all'), ($2, 'all')`,
    [approved.id, draft.id]
  )

  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const deps = res.json().deployments
  assert.equal(deps.length, 1)
  assert.equal(deps[0].install_script, 'Write-Output fanout')

  const { rows: snaps } = await db.query(`
    SELECT s.install_script FROM deployment_snapshots s
    JOIN deployments d ON d.id = s.deployment_id
    WHERE d.device_id = $1 AND d.package_id = $2
  `, [device.id, approved.id])
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].install_script, 'Write-Output fanout')

  // Job d'un package draft : aucune ligne créée tant qu'il n'est pas approuvé.
  const { rows: draftDeps } = await db.query(
    `SELECT count(*)::int AS n FROM deployments WHERE device_id = $1 AND package_id = $2`,
    [device.id, draft.id]
  )
  assert.equal(draftDeps[0].n, 0)
})

// ─── POST /checkin — validation des champs remontés par l'agent ──────────────

async function deviceNetbird(id) {
  const { rows: [d] } = await db.query(`SELECT ip_netbird FROM devices WHERE id = $1`, [id])
  return d.ip_netbird
}

test('POST /checkin — ip_netbird : seule une IPv4 de 100.64.0.0/10 est stockée', { skip: SKIP }, async () => {
  // Sécu : ip_netbird est la cible des connexions SSH / scripts lancées par
  // l'API. Un agent (ou token) compromis ne doit pas pouvoir la pointer vers
  // une autre machine (127.0.0.1, LAN serveur, Internet…).
  const device = await seedDevice(db, { hostname: 'PC-NETBIRD', ipNetbird: '100.64.0.9' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const send = (ip_netbird) => fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: { hostname: device.hostname, ...(ip_netbird === undefined ? {} : { ip_netbird }) },
  })

  // Valeurs légitimes (bords de la plage inclus).
  for (const ok of ['100.64.0.1', '100.127.255.254', '100.100.3.7']) {
    const res = await send(ok)
    assert.equal(res.statusCode, 200, `body: ${res.body}`)
    assert.equal(await deviceNetbird(device.id), ok)
  }

  // Champ absent (agent sans Netbird, omitempty) → valeur conservée.
  assert.equal((await send(undefined)).statusCode, 200)
  assert.equal(await deviceNetbird(device.id), '100.100.3.7')

  // Hors plage / invalide → checkin accepté, IP stockée NULL.
  for (const bad of ['10.0.0.5', '127.0.0.1', '100.128.0.1', '100.63.255.255', '192.168.1.10',
    '::1', 'evil.example.com', '100.64.0.1; rm -rf /', '100.064.0.1']) {
    await db.query(`UPDATE devices SET ip_netbird = '100.64.0.9' WHERE id = $1`, [device.id])
    const res = await send(bad)
    assert.equal(res.statusCode, 200, `body: ${res.body}`)
    assert.equal(await deviceNetbird(device.id), null, `${bad} doit être rejetée`)
  }
})

test('POST /checkin — ip_netbird invalide sur un nouveau device → NULL', { skip: SKIP }, async () => {
  const t = await seedAgentToken(db, { label: 'netbird-new-device' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(t.secret),
    payload: { hostname: 'PC-NETBIRD-NEW', ip_netbird: '10.1.2.3' },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.equal(await deviceNetbird(res.json().device_id), null)
})

test('POST /checkin — type d\'interface : liste blanche (eth|wifi|netbird), absent → eth, inconnu → NULL', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-IFACE-TYPE' })
  const { secret } = await seedAgentToken(db, { deviceId: device.id })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload: {
      hostname: device.hostname,
      network: [
        // Format exact de l'agent Go (NetIface) : type toujours envoyé.
        { mac: '00:11:22:33:44:01', ip: '192.168.1.20', adapter: 'Ethernet',  type: 'eth' },
        { mac: '00:11:22:33:44:02', ip: '192.168.1.21', adapter: 'Wi-Fi',     type: 'wifi' },
        { mac: '00:11:22:33:44:03', ip: '100.64.0.20',  adapter: 'wt0',       type: 'netbird' },
        { mac: '00:11:22:33:44:04', ip: '192.168.1.22', adapter: 'Legacy' },
        { mac: '00:11:22:33:44:05', ip: '192.168.1.23', adapter: 'Evil', type: '<img src=x onerror=alert(1)>' },
        { mac: '00:11:22:33:44:06', ip: '192.168.1.24', adapter: 'Obj',  type: { toString: 'x' } },
        null,
      ],
    },
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const { rows } = await db.query(
    `SELECT mac, type FROM network_interfaces WHERE device_id = $1 ORDER BY mac`, [device.id]
  )
  assert.deepEqual(rows.map(r => r.type), ['eth', 'wifi', 'netbird', 'eth', null, null])
})

// ─── POST /exchange-token ──────────────────────────────────────────────────

test('POST /exchange-token — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    payload: { hostname: 'PC-X' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /exchange-token — hostname manquant → 400', { skip: SKIP }, async () => {
  const { secret } = await seedAgentToken(db, {
    label: 'bootstrap-validation',
    isBootstrap: true,
    bootstrapMaxRedeems: 100,
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: bearer(secret),
    payload: {},
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /hostname/)
})

test('POST /exchange-token — bootstrap inconnu → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: bearer('z'.repeat(64)),
    payload: { hostname: 'PC-X' },
  })
  assert.equal(res.statusCode, 401)
})

test('POST /exchange-token — bootstrap quota atteint → 401', { skip: SKIP }, async () => {
  // Pattern Tailscale/Netbird : un setup-key avec un quota fini. Une fois
  // épuisé, plus aucun échange n'est accepté — l'admin doit régénérer.
  const { secret } = await seedAgentToken(db, {
    label: 'quota-epuise',
    isBootstrap: true,
    bootstrapMaxRedeems: 1,
    bootstrapRedeemedCount: 1, // déjà au max
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: bearer(secret),
    payload: { hostname: 'PC-QUOTA' },
  })
  assert.equal(res.statusCode, 401)
  assert.match(res.json().error, /quota/i)
})

test('POST /exchange-token — happy path : crée device, retourne token, incrémente redeem', { skip: SKIP }, async () => {
  const bootstrap = await seedAgentToken(db, {
    label: 'bootstrap-ok',
    isBootstrap: true,
    bootstrapMaxRedeems: 10,
    bootstrapRedeemedCount: 0,
  })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: bearer(bootstrap.secret),
    payload: { hostname: 'PC-FROM-BOOTSTRAP', serial: 'SN-12345' },
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.match(body.token, /^[0-9a-f]{64}$/)
  assert.ok(body.device_id)
  assert.equal(body.hostname, 'PC-FROM-BOOTSTRAP')

  // Device créé avec le serial fourni.
  const { rows: devs } = await db.query(
    `SELECT serial FROM devices WHERE id = $1`, [body.device_id]
  )
  assert.equal(devs[0].serial, 'SN-12345')

  // bootstrap_redeemed_count incrémenté.
  const { rows: bs } = await db.query(
    `SELECT bootstrap_redeemed_count, bootstrap_redeemed_at FROM agent_tokens WHERE id = $1`,
    [bootstrap.id]
  )
  assert.equal(bs[0].bootstrap_redeemed_count, 1)
  assert.ok(bs[0].bootstrap_redeemed_at)
})

// ─── POST /exchange-token — poste déjà connu (règles d'enrôlement) ───────────

// Device pré-créé (ex. sync Intune) avec un numéro de série.
async function seedDeviceWithSerial(db, hostname, serial) {
  const r = await db.query(
    `INSERT INTO devices (hostname, serial, source, last_seen)
     VALUES ($1, $2, 'intune', now()) RETURNING id, hostname`,
    [hostname, serial]
  )
  return r.rows[0]
}

async function seedBootstrap(label) {
  return seedAgentToken(db, { label, isBootstrap: true, bootstrapMaxRedeems: 100 })
}

// Token agent lié à `deviceId` qui a déjà servi (un agent a fait un checkin).
async function seedUsedToken(deviceId, label = 'used') {
  const t = await seedAgentToken(db, { deviceId, label })
  await db.query(`UPDATE agent_tokens SET last_used_at = now() WHERE id = $1`, [t.id])
  return t
}

async function exchange(bootstrapSecret, payload) {
  return fastify.inject({
    method: 'POST', url: '/api/agent/exchange-token',
    headers: bearer(bootstrapSecret),
    payload,
  })
}

async function lastRefusal(deviceId) {
  const { rows } = await db.query(
    `SELECT by_user, details FROM audit_logs
     WHERE action = 'agent_bootstrap_exchange_refused' AND target = $1
     ORDER BY created_at DESC LIMIT 1`,
    [deviceId]
  )
  return rows[0] || null
}

test('POST /exchange-token — poste pré-synchronisé, série concordante (normalisée), sans token → 201 lié au device existant', { skip: SKIP }, async () => {
  const device = await seedDeviceWithSerial(db, 'PC-PRESYNC', 'SN-PRESYNC-1')
  const bootstrap = await seedBootstrap('bs-presync')

  // L'installeur envoie la série BIOS brute : casse / espaces peuvent différer.
  const res = await exchange(bootstrap.secret, { hostname: 'PC-PRESYNC', serial: '  sn-presync-1 ' })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)
  assert.equal(res.json().device_id, device.id)

  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM devices WHERE hostname = 'PC-PRESYNC'`
  )
  assert.equal(n, 1, 'pas de nouveau device')

  // Le token émis est utilisable pour le checkin du poste.
  const checkin = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(res.json().token),
    payload: { hostname: 'PC-PRESYNC', serial: 'SN-PRESYNC-1' },
  })
  assert.equal(checkin.statusCode, 200, `body: ${checkin.body}`)
  assert.equal(checkin.json().device_id, device.id)
})

test('POST /exchange-token — poste pré-synchronisé sans série (NULL) et sans token → 201', { skip: SKIP }, async () => {
  // Cas prod observé : Intune n'a pas toujours la série BIOS. Sans série de
  // référence, seule la règle « aucun token actif déjà utilisé » s'applique.
  const device = await seedDevice(db, { hostname: 'PC-PRESYNC-NOSERIAL' })
  const bootstrap = await seedBootstrap('bs-presync-noserial')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-PRESYNC-NOSERIAL', serial: 'ANY-SERIAL' })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)
  assert.equal(res.json().device_id, device.id)
})

test('POST /exchange-token — série bidon côté device (« To be filled by O.E.M. ») traitée comme absente → 201', { skip: SKIP }, async () => {
  const device = await seedDeviceWithSerial(db, 'PC-FAKE-SERIAL', 'To be filled by O.E.M.')
  const bootstrap = await seedBootstrap('bs-fake-serial')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-FAKE-SERIAL', serial: '' })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)
  assert.equal(res.json().device_id, device.id)
})

test('POST /exchange-token — série différente → 403, aucun token émis, quota non consommé, audit', { skip: SKIP }, async () => {
  // Sécu : un bootstrap fuité ne permet plus d'usurper un poste existant
  // en envoyant simplement son hostname.
  const device = await seedDeviceWithSerial(db, 'PC-VICTIM-SERIAL', 'SN-VICTIM')
  const bootstrap = await seedBootstrap('bs-serial-mismatch')

  const res = await exchange(bootstrap.secret, { hostname: 'PC-VICTIM-SERIAL', serial: 'SN-ATTACKER' })
  assert.equal(res.statusCode, 403, `body: ${res.body}`)
  assert.match(res.json().error, /série/)

  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM agent_tokens WHERE device_id = $1`, [device.id]
  )
  assert.equal(n, 0, 'aucun token lié au device')
  const { rows: [bs] } = await db.query(
    `SELECT bootstrap_redeemed_count FROM agent_tokens WHERE id = $1`, [bootstrap.id]
  )
  assert.equal(bs.bootstrap_redeemed_count, 0)

  const audit = await lastRefusal(device.id)
  assert.ok(audit, 'refus tracé dans audit_logs')
  assert.equal(audit.by_user, 'PC-VICTIM-SERIAL')
  assert.equal(audit.details.reason, 'serial_mismatch')
  assert.equal(audit.details.bootstrap_label, 'bs-serial-mismatch')
  assert.equal(audit.details.serial, 'SN-ATTACKER')
})

test('POST /exchange-token — série absente alors que le device en a une → 403', { skip: SKIP }, async () => {
  const device = await seedDeviceWithSerial(db, 'PC-NO-SERIAL-SENT', 'SN-KNOWN')
  const bootstrap = await seedBootstrap('bs-serial-missing')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-NO-SERIAL-SENT' })
  assert.equal(res.statusCode, 403)
  assert.equal((await lastRefusal(device.id)).details.reason, 'serial_missing')
})

test('POST /exchange-token — token actif déjà utilisé sur le device → 409 (même série), audit', { skip: SKIP }, async () => {
  // Poste déjà enrôlé : même avec la bonne série (ex. PC réinstallé), un
  // admin doit d'abord révoquer l'ancien token.
  const device = await seedDeviceWithSerial(db, 'PC-ENROLLED', 'SN-ENROLLED')
  const active = await seedUsedToken(device.id, 'enrolled')
  const bootstrap = await seedBootstrap('bs-active-token')

  const res = await exchange(bootstrap.secret, { hostname: 'PC-ENROLLED', serial: 'SN-ENROLLED' })
  assert.equal(res.statusCode, 409, `body: ${res.body}`)
  assert.match(res.json().error, /révoquer/)
  const audit = await lastRefusal(device.id)
  assert.equal(audit.details.reason, 'active_token')
  assert.equal(audit.details.active_token_id, active.id)
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM agent_tokens WHERE device_id = $1`, [device.id]
  )
  assert.equal(n, 1, 'aucun nouveau token')

  // Réenrôlement après révocation admin de l'ancien token → OK.
  await db.query(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [active.id])
  const again = await exchange(bootstrap.secret, { hostname: 'PC-ENROLLED', serial: 'SN-ENROLLED' })
  assert.equal(again.statusCode, 201, `body: ${again.body}`)
  assert.equal(again.json().device_id, device.id)
})

test('POST /exchange-token — ancien token expiré (grace de rotation passée) ne bloque pas', { skip: SKIP }, async () => {
  const device = await seedDeviceWithSerial(db, 'PC-EXPIRED-TOKEN', 'SN-EXPIRED-TOKEN')
  const old = await seedAgentToken(db, {
    deviceId: device.id, expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  await db.query(`UPDATE agent_tokens SET last_used_at = now() WHERE id = $1`, [old.id])
  const bootstrap = await seedBootstrap('bs-expired-token')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-EXPIRED-TOKEN', serial: 'SN-EXPIRED-TOKEN' })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)
})

test('POST /exchange-token — relance après install interrompue (token jamais utilisé) → 201 et ancien token révoqué', { skip: SKIP }, async () => {
  // L'installeur Intune échange le bootstrap PUIS télécharge le binaire :
  // s'il échoue entre les deux, Intune le relance. Le token émis au premier
  // essai n'a jamais servi à un checkin → il ne doit pas bloquer la relance,
  // et il est révoqué (un seul credential vivant par poste).
  const bootstrap = await seedBootstrap('bs-retry-install')
  const first = await exchange(bootstrap.secret, { hostname: 'PC-RETRY-INSTALL', serial: 'SN-RETRY' })
  assert.equal(first.statusCode, 201)
  const second = await exchange(bootstrap.secret, { hostname: 'PC-RETRY-INSTALL', serial: 'SN-RETRY' })
  assert.equal(second.statusCode, 201, `body: ${second.body}`)
  assert.equal(second.json().device_id, first.json().device_id)

  const oldUse = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(first.json().token),
    payload: { hostname: 'PC-RETRY-INSTALL', serial: 'SN-RETRY' },
  })
  assert.equal(oldUse.statusCode, 401, 'le token du premier essai est révoqué')
  const newUse = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(second.json().token),
    payload: { hostname: 'PC-RETRY-INSTALL', serial: 'SN-RETRY' },
  })
  assert.equal(newUse.statusCode, 200, `body: ${newUse.body}`)

  // Une fois l'agent enrôlé (checkin fait), une 3e tentative est refusée.
  const third = await exchange(bootstrap.secret, { hostname: 'PC-RETRY-INSTALL', serial: 'SN-RETRY' })
  assert.equal(third.statusCode, 409)
})

test('POST /exchange-token — fenêtre de rotation : le token successeur jamais utilisé bloque l\'exchange et n\'est pas révoqué', { skip: SKIP }, async () => {
  // Le PC a appelé /rotate-token puis s'est éteint > 24 h : l'ancien token
  // (utilisé) est expiré, le successeur (created_by = 'agent-rotation') n'a
  // pas encore servi. Le poste reste enrôlé : un porteur du bootstrap ne
  // doit ni obtenir de token, ni révoquer celui de l'agent légitime.
  const device = await seedDevice(db, { hostname: 'PC-ROTATION-GAP' }) // série NULL
  const old = await seedAgentToken(db, { deviceId: device.id, label: 'rot-old' })
  const rotate = await fastify.inject({
    method: 'POST', url: '/api/agent/rotate-token',
    headers: bearer(old.secret),
  })
  assert.equal(rotate.statusCode, 200, `body: ${rotate.body}`)
  const successor = rotate.json().token
  // Ancien token : a servi, puis grace de 24 h écoulée.
  await db.query(
    `UPDATE agent_tokens SET last_used_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
     WHERE id = $1`,
    [old.id]
  )

  const bootstrap = await seedBootstrap('bs-rotation-gap')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-ROTATION-GAP', serial: 'ANY' })
  assert.equal(res.statusCode, 409, `body: ${res.body}`)
  assert.equal((await lastRefusal(device.id)).details.reason, 'active_token')

  // Le successeur n'a pas été révoqué : l'agent légitime continue.
  const checkin = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(successor),
    payload: { hostname: 'PC-ROTATION-GAP' },
  })
  assert.equal(checkin.statusCode, 200, `body: ${checkin.body}`)
})

test('POST /checkin — fenêtre de rotation : un token non lié ne se rattache pas au poste', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-ROTATION-GAP-2' })
  const old = await seedAgentToken(db, { deviceId: device.id, label: 'rot-old-2' })
  const rotate = await fastify.inject({
    method: 'POST', url: '/api/agent/rotate-token',
    headers: bearer(old.secret),
  })
  assert.equal(rotate.statusCode, 200)
  await db.query(
    `UPDATE agent_tokens SET last_used_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
     WHERE id = $1`,
    [old.id]
  )
  const t = await seedAgentToken(db, { label: 'unbound-rotation-gap' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(t.secret),
    payload: { hostname: 'PC-ROTATION-GAP-2' },
  })
  assert.equal(res.statusCode, 409, `body: ${res.body}`)
})

test('POST /exchange-token — les tokens non utilisés révoqués à l\'exchange n\'incluent jamais un token de rotation', { skip: SKIP }, async () => {
  // Défense en profondeur : même si le check d'enrôlement passait (ex. token
  // de rotation lui-même expiré), l'UPDATE de révocation ne touche pas les
  // tokens 'agent-rotation'.
  const device = await seedDevice(db, { hostname: 'PC-ROTATION-REVOKE' })
  const rot = await seedAgentToken(db, {
    deviceId: device.id, label: 'rot-expired', createdBy: 'agent-rotation',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const orphan = await seedAgentToken(db, { deviceId: device.id, label: 'orphan', createdBy: 'bootstrap:x' })
  const bootstrap = await seedBootstrap('bs-rotation-revoke')
  const res = await exchange(bootstrap.secret, { hostname: 'PC-ROTATION-REVOKE', serial: 'ANY' })
  assert.equal(res.statusCode, 201, `body: ${res.body}`)
  const { rows } = await db.query(
    `SELECT id, revoked_at FROM agent_tokens WHERE id = ANY($1::uuid[])`, [[rot.id, orphan.id]]
  )
  const revoked = Object.fromEntries(rows.map(r => [r.id, r.revoked_at]))
  assert.equal(revoked[rot.id], null, 'token de rotation jamais révoqué par l\'exchange')
  assert.ok(revoked[orphan.id], 'token orphelin d\'une install interrompue révoqué')
})

// ─── POST /checkin — token non lié (Paramètres → Tokens + install.ps1) ───────

async function checkinWith(secret, payload) {
  return fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(secret),
    payload,
  })
}

async function tokenDevice(tokenId) {
  const { rows: [t] } = await db.query(`SELECT device_id FROM agent_tokens WHERE id = $1`, [tokenId])
  return t.device_id
}

test('POST /checkin — token non lié, nouveau hostname → device créé et token lié', { skip: SKIP }, async () => {
  const t = await seedAgentToken(db, { label: 'unbound-new' })
  const res = await checkinWith(t.secret, { hostname: 'PC-UNBOUND-NEW', serial: 'SN-UNBOUND-NEW' })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.equal(res.json().new, true)
  assert.equal(await tokenDevice(t.id), res.json().device_id)
})

test('POST /checkin — token non lié, poste pré-synchronisé (série concordante, sans token) → lié', { skip: SKIP }, async () => {
  // install.ps1 manuel sur un PC déjà remonté par la sync Intune.
  const device = await seedDeviceWithSerial(db, 'PC-UNBOUND-PRESYNC', 'SN-UNBOUND-PRESYNC')
  const t = await seedAgentToken(db, { label: 'unbound-presync' })
  const res = await checkinWith(t.secret, { hostname: 'PC-UNBOUND-PRESYNC', serial: 'SN-UNBOUND-PRESYNC' })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.equal(res.json().device_id, device.id)
  assert.equal(await tokenDevice(t.id), device.id)
})

test('POST /checkin — token non lié, poste existant sans série et sans token → lié', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-UNBOUND-NOSERIAL' })
  const t = await seedAgentToken(db, { label: 'unbound-noserial' })
  const res = await checkinWith(t.secret, { hostname: 'PC-UNBOUND-NOSERIAL', serial: 'SN-WHATEVER' })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  assert.equal(await tokenDevice(t.id), device.id)
})

test('POST /checkin — token non lié sur un poste déjà enrôlé → 409, aucun rattachement ni mutation, audit', { skip: SKIP }, async () => {
  // Sécu : un token non lié fuité ne doit pas permettre d'usurper un poste
  // existant (ni de recevoir ses scripts / déploiements).
  const device = await seedDeviceWithSerial(db, 'PC-UNBOUND-VICTIM', 'SN-UNBOUND-VICTIM')
  await seedUsedToken(device.id, 'victim-token')
  await db.query(`UPDATE devices SET os = 'Windows 11 Pro' WHERE id = $1`, [device.id])
  const t = await seedAgentToken(db, { label: 'unbound-attacker' })

  const res = await checkinWith(t.secret, {
    hostname: 'PC-UNBOUND-VICTIM', serial: 'SN-UNBOUND-VICTIM', os: 'Pwned OS',
  })
  assert.equal(res.statusCode, 409, `body: ${res.body}`)
  assert.equal(await tokenDevice(t.id), null, 'le token reste non lié')
  const { rows: [dev] } = await db.query(`SELECT os FROM devices WHERE id = $1`, [device.id])
  assert.equal(dev.os, 'Windows 11 Pro', 'aucune mutation du device')

  const { rows: [audit] } = await db.query(
    `SELECT details FROM audit_logs WHERE action = 'agent_token_bind_refused' AND target = $1
     ORDER BY created_at DESC LIMIT 1`,
    [device.id]
  )
  assert.ok(audit, 'refus tracé dans audit_logs')
  assert.equal(audit.details.reason, 'active_token')
  assert.equal(audit.details.token_id, t.id)
})

test('POST /checkin — token non lié, poste existant avec une autre série → 403', { skip: SKIP }, async () => {
  const device = await seedDeviceWithSerial(db, 'PC-UNBOUND-OTHER', 'SN-UNBOUND-REAL')
  const t = await seedAgentToken(db, { label: 'unbound-other-serial' })
  const res = await checkinWith(t.secret, { hostname: 'PC-UNBOUND-OTHER', serial: 'SN-UNBOUND-FAKE' })
  assert.equal(res.statusCode, 403, `body: ${res.body}`)
  assert.equal(await tokenDevice(t.id), null)
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM devices WHERE hostname = 'PC-UNBOUND-OTHER'`
  )
  assert.equal(n, 1, 'pas de device dupliqué')
  const { rows: [{ bound }] } = await db.query(
    `SELECT count(*)::int AS bound FROM agent_tokens WHERE device_id = $1`, [device.id]
  )
  assert.equal(bound, 0, 'aucun token rattaché au poste')
})

// ─── POST /rotate-token ────────────────────────────────────────────────────

test('POST /rotate-token — sans Bearer → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/rotate-token',
  })
  assert.equal(res.statusCode, 401)
})

test('POST /rotate-token — happy path : émet nouveau token + ancien avec expires_at + replaced_by', { skip: SKIP }, async () => {
  const device = await seedDevice(db, { hostname: 'PC-ROTATE' })
  const old = await seedAgentToken(db, { deviceId: device.id, label: 'orig' })
  const res = await fastify.inject({
    method: 'POST', url: '/api/agent/rotate-token',
    headers: bearer(old.secret),
  })
  assert.equal(res.statusCode, 200, `body: ${res.body}`)
  const body = res.json()
  assert.match(body.token, /^[0-9a-f]{64}$/)

  // L'ancien token a maintenant expires_at (grace 24h) + replaced_by pointant
  // sur le nouveau.
  const { rows: oldRow } = await db.query(
    `SELECT expires_at, replaced_by FROM agent_tokens WHERE id = $1`, [old.id]
  )
  assert.ok(oldRow[0].expires_at)
  const graceMs = new Date(oldRow[0].expires_at).getTime() - Date.now()
  assert.ok(graceMs > 23 * 3600_000 && graceMs < 25 * 3600_000,
    `grace 24h ± 1h (got ${graceMs / 3600_000}h)`)
  assert.ok(oldRow[0].replaced_by)

  // Le nouveau token est utilisable immédiatement.
  const checkin = await fastify.inject({
    method: 'POST', url: '/api/agent/checkin',
    headers: bearer(body.token),
    payload: { hostname: device.hostname },
  })
  assert.equal(checkin.statusCode, 200, 'nouveau token doit accepter un checkin')
})

// ─── GET /version ──────────────────────────────────────────────────────────

test('GET /version — sans token → 401', { skip: SKIP }, async () => {
  const res = await fastify.inject({ method: 'GET', url: '/api/agent/version' })
  assert.equal(res.statusCode, 401)
})

test('GET /version — token valide → 200 + latest_version (peut être null en test)', { skip: SKIP }, async () => {
  const { secret } = await seedAgentToken(db, { label: 'version-check' })
  const res = await fastify.inject({
    method: 'GET', url: '/api/agent/version',
    headers: bearer(secret),
  })
  assert.equal(res.statusCode, 200)
  // En env de test le sidecar dist/agent-version.txt n'existe pas forcément.
  // On accepte null OU une string semver — le contrat est juste "réponse JSON
  // avec un champ latest_version".
  assert.ok('latest_version' in res.json())
})
