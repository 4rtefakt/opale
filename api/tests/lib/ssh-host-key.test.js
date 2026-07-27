import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { hostKeyFingerprint, hostKeyPolicy, makeHostVerifier, loadKnownHostKey }
  from '../../modules/remote/lib/ssh-host-key.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'

const silent = { info() {}, warn() {}, error() {} }
const KEY_A = Buffer.from('ssh-ed25519 AAAA-poste-legitime')
const KEY_B = Buffer.from('ssh-ed25519 AAAA-imposteur')

// ─── Empreinte et politique (sans DB) ─────────────────────────────────────

test('hostKeyFingerprint : SHA-256 base64 sans padding, stable', () => {
  const fp = hostKeyFingerprint(KEY_A)
  assert.match(fp, /^[A-Za-z0-9+/]+$/)
  assert.equal(fp, hostKeyFingerprint(Buffer.from('ssh-ed25519 AAAA-poste-legitime')))
  assert.notEqual(fp, hostKeyFingerprint(KEY_B))
})

test('hostKeyPolicy : tofu par défaut, strict sur demande', () => {
  assert.equal(hostKeyPolicy({}), 'tofu')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'strict' }), 'strict')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'STRICT' }), 'strict')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'nimportequoi' }), 'tofu')
})

// ─── Vérificateur contre une vraie base ───────────────────────────────────

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
let ctx = null, device = null

before(async () => { if (isDbAvailable()) ctx = await acquireSchema() })
after(async () => { if (ctx) await ctx.release(); await closeSharedPool() })

beforeEach(async () => {
  if (!ctx) return
  await ctx.db.query('DELETE FROM audit_logs')
  await ctx.db.query('DELETE FROM devices')
  device = await seedDevice(ctx.db, { hostname: 'PC-HOSTKEY', ipNetbird: '100.64.0.7' })
})

test('premier contact : accepte et mémorise l\'empreinte', { skip: SKIP }, async () => {
  const verify = makeHostVerifier({ db: ctx.db, log: silent }, device, null)
  assert.equal(verify(KEY_A), true)

  // La mémorisation est asynchrone (ssh2 exige un retour synchrone).
  await new Promise(r => setTimeout(r, 120))
  assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_A))
})

test('contact suivant avec la même clé : accepté', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await ctx.db.query('UPDATE devices SET ssh_host_key_fp = $1 WHERE id = $2', [fp, device.id])

  const verify = makeHostVerifier({ db: ctx.db, log: silent }, device, fp)
  assert.equal(verify(KEY_A), true)
})

test('clé différente : REFUSÉE, message d\'erreur remonté, audit écrit', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await ctx.db.query('UPDATE devices SET ssh_host_key_fp = $1 WHERE id = $2', [fp, device.id])

  let rejection = null
  const verify = makeHostVerifier(
    { db: ctx.db, log: silent }, device, fp, { onReject: (m) => { rejection = m } }
  )
  assert.equal(verify(KEY_B), false, 'la poignée de main doit être avortée')
  assert.match(rejection, /interception|inattendue/)

  await new Promise(r => setTimeout(r, 120))
  const { rows } = await ctx.db.query(
    `SELECT details FROM audit_logs WHERE action = 'ssh_host_key_mismatch'`
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].details.presented_fingerprint, hostKeyFingerprint(KEY_B))
})

test('clé différente : l\'empreinte enregistrée n\'est PAS écrasée', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await ctx.db.query('UPDATE devices SET ssh_host_key_fp = $1 WHERE id = $2', [fp, device.id])

  makeHostVerifier({ db: ctx.db, log: silent }, device, fp)(KEY_B)
  await new Promise(r => setTimeout(r, 120))

  assert.equal(await loadKnownHostKey(ctx.db, device.id), fp,
    'un imposteur ne doit pas pouvoir réécrire l\'empreinte de confiance')
})

test('politique strict : refuse même le premier contact', { skip: SKIP }, async () => {
  let rejection = null
  const verify = makeHostVerifier(
    { db: ctx.db, log: silent }, device, null,
    { policy: 'strict', onReject: (m) => { rejection = m } }
  )
  assert.equal(verify(KEY_A), false)
  assert.match(rejection, /strict/)

  await new Promise(r => setTimeout(r, 120))
  assert.equal(await loadKnownHostKey(ctx.db, device.id), null)
})

test('deux premiers contacts concurrents : une seule empreinte gagne', { skip: SKIP }, async () => {
  // Le WHERE ssh_host_key_fp IS NULL rend l'apprentissage idempotent : deux
  // connexions simultanées sur un device neuf ne peuvent pas se contredire.
  makeHostVerifier({ db: ctx.db, log: silent }, device, null)(KEY_A)
  makeHostVerifier({ db: ctx.db, log: silent }, device, null)(KEY_B)
  await new Promise(r => setTimeout(r, 150))

  const stored = await loadKnownHostKey(ctx.db, device.id)
  assert.ok([hostKeyFingerprint(KEY_A), hostKeyFingerprint(KEY_B)].includes(stored))
})

test('après réinitialisation, l\'empreinte est réapprise', { skip: SKIP }, async () => {
  const fpA = hostKeyFingerprint(KEY_A)
  await ctx.db.query('UPDATE devices SET ssh_host_key_fp = $1 WHERE id = $2', [fpA, device.id])

  // Réinstallation du poste → l'admin réinitialise depuis la fiche.
  await ctx.db.query('UPDATE devices SET ssh_host_key_fp = NULL WHERE id = $1', [device.id])

  const verify = makeHostVerifier({ db: ctx.db, log: silent }, device, null)
  assert.equal(verify(KEY_B), true)
  await new Promise(r => setTimeout(r, 120))
  assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_B))
})
