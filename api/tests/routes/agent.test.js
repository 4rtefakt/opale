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
