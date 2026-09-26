import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  hostKeyFingerprint, hostKeyPolicy, normalizeFingerprint, hostKeyGuard,
  loadKnownHostKey, SSH_HOST_KEY_ALGORITHMS,
} from '../../modules/remote/lib/ssh-host-key.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { seedDevice } from '../fixtures/devices.js'

const silent = { info() {}, warn() {}, error() {} }
const KEY_A = Buffer.from('ssh-ed25519 AAAA-poste-legitime')
const KEY_B = Buffer.from('ssh-ed25519 AAAA-imposteur')

// Rejoue ce que fait ssh2 : appelle le hostVerifier avec la clé présentée et
// attend la réponse passée à `verify` (le vérificateur est asynchrone).
function handshake(guard, key) {
  return new Promise((resolve, reject) => {
    const ret = guard.hostVerifier(key, resolve)
    if (ret !== undefined) reject(new Error('le hostVerifier doit répondre via verify()'))
  })
}

// ─── Empreinte et politique (sans DB) ─────────────────────────────────────

test('hostKeyFingerprint : SHA-256 base64 sans padding, stable', () => {
  const fp = hostKeyFingerprint(KEY_A)
  assert.match(fp, /^[A-Za-z0-9+/]+$/)
  assert.equal(fp, hostKeyFingerprint(Buffer.from('ssh-ed25519 AAAA-poste-legitime')))
  assert.notEqual(fp, hostKeyFingerprint(KEY_B))
})

test('normalizeFingerprint : préfixe SHA256:, padding et espaces ignorés', () => {
  const fp = hostKeyFingerprint(KEY_A)
  assert.equal(normalizeFingerprint(fp), fp)
  assert.equal(normalizeFingerprint(`SHA256:${fp}`), fp)
  assert.equal(normalizeFingerprint(`${fp}=`), fp)
  assert.equal(normalizeFingerprint(`  SHA256:${fp}=\n`), fp)
  assert.equal(normalizeFingerprint(`SHA256: ${fp}`), fp)
  assert.equal(normalizeFingerprint('SHA256:'), null)
  assert.equal(normalizeFingerprint(''), null)
  assert.equal(normalizeFingerprint(null), null)
})

test('hostKeyPolicy : tofu par défaut, strict sur demande, valeur inconnue signalée', () => {
  assert.equal(hostKeyPolicy({}), 'tofu')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'strict' }), 'strict')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'STRICT' }), 'strict')
  const warned = []
  const log = { warn: (obj) => warned.push(obj) }
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'nimportequoi' }, log), 'tofu')
  assert.equal(hostKeyPolicy({ OPALE_SSH_HOST_KEY_POLICY: 'tofu' }, log), 'tofu')
  assert.deepEqual(warned, [{ value: 'nimportequoi' }])
})

test('sshOptions : vérificateur et algorithmes de clé d\'hôte figés', () => {
  const guard = hostKeyGuard({ db: {}, log: silent }, { id: 'x', hostname: 'PC' })
  assert.equal(guard.sshOptions.hostVerifier, guard.hostVerifier)
  assert.deepEqual(guard.sshOptions.algorithms.serverHostKey, [...SSH_HOST_KEY_ALGORITHMS])
  assert.equal(SSH_HOST_KEY_ALGORITHMS[0], 'ssh-ed25519')
})

test('erreur de base : connexion REFUSÉE (pas d\'acceptation par défaut)', async () => {
  const failing = { query: async () => { throw new Error('connexion perdue') } }
  let rejection = null
  const guard = hostKeyGuard({ db: failing, log: silent }, { id: 'x', hostname: 'PC-DBKO' },
    { onReject: (m) => { rejection = m } })
  assert.equal(await handshake(guard, KEY_A), false)
  assert.match(rejection, /impossible/)
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

const guardFor = (opts) => hostKeyGuard({ db: ctx.db, log: silent }, device, opts)
const storeFp = (fp) => ctx.db.query('UPDATE devices SET ssh_host_key_fp = $1 WHERE id = $2', [fp, device.id])
const auditRows = async (action) => (await ctx.db.query(
  'SELECT details FROM audit_logs WHERE action = $1', [action]
)).rows

test('premier contact : accepté, mémorisé seulement après authentification (confirm)', { skip: SKIP }, async () => {
  const guard = guardFor()
  assert.equal(await handshake(guard, KEY_A), true)
  // Hôte qui refuserait ensuite la clé d'Opale : rien n'est épinglé.
  assert.equal(await loadKnownHostKey(ctx.db, device.id), null)
  assert.equal((await auditRows('ssh_host_key_learned')).length, 0)

  assert.equal(await guard.confirm(), true)
  assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_A))
  const learned = await auditRows('ssh_host_key_learned')
  assert.equal(learned.length, 1)
  assert.equal(learned[0].details.fingerprint, hostKeyFingerprint(KEY_A))
})

test('contact suivant avec la même clé : accepté, rien de réécrit', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await storeFp(fp)

  const guard = guardFor()
  assert.equal(await handshake(guard, KEY_A), true)
  assert.equal(await guard.confirm(), true)
  assert.equal((await auditRows('ssh_host_key_learned')).length, 0)
})

test('empreinte stockée au format OpenSSH (SHA256:…) ou avec padding : acceptée', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  for (const stored of [`SHA256:${fp}`, `${fp}=`]) {
    await storeFp(stored)
    const guard = guardFor()
    assert.equal(await handshake(guard, KEY_A), true, stored)
    assert.equal(await handshake(guardFor(), KEY_B), false, `imposteur refusé (${stored})`)
  }
})

test('clé différente : REFUSÉE, message d\'erreur remonté, audit de niveau error', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await storeFp(fp)

  let rejection = null
  const guard = guardFor({ onReject: (m) => { rejection = m } })
  assert.equal(await handshake(guard, KEY_B), false, 'la poignée de main doit être avortée')
  assert.match(rejection, /interception|inattendue/)
  assert.equal(await guard.confirm(), false)

  const rows = await auditRows('ssh_host_key_mismatch')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].details.level, 'error')
  assert.equal(rows[0].details.expected_fingerprint, fp)
  assert.equal(rows[0].details.presented_fingerprint, hostKeyFingerprint(KEY_B))
})

test('clé différente : l\'empreinte enregistrée n\'est PAS écrasée', { skip: SKIP }, async () => {
  const fp = hostKeyFingerprint(KEY_A)
  await storeFp(fp)

  const guard = guardFor()
  await handshake(guard, KEY_B)
  await guard.confirm()

  assert.equal(await loadKnownHostKey(ctx.db, device.id), fp,
    'un imposteur ne doit pas pouvoir réécrire l\'empreinte de confiance')
})

test('politique strict : refuse même le premier contact', { skip: SKIP }, async () => {
  let rejection = null
  const guard = guardFor({ policy: 'strict', onReject: (m) => { rejection = m } })
  assert.equal(await handshake(guard, KEY_A), false)
  assert.match(rejection, /strict/)
  assert.equal(await guard.confirm(), false)
  assert.equal(await loadKnownHostKey(ctx.db, device.id), null)
})

test('deux premiers contacts concurrents : le second ne reçoit AUCUNE commande', { skip: SKIP }, async () => {
  // Les deux poignées de main voient un poste sans empreinte.
  const first = guardFor()
  let rejection = null
  const second = guardFor({ onReject: (m) => { rejection = m } })
  assert.equal(await handshake(first, KEY_A), true)
  assert.equal(await handshake(second, KEY_B), true)

  // Le premier mémorise A ; le second ne doit ni écraser A (WHERE … IS NULL)
  // ni être autorisé à continuer.
  assert.equal(await first.confirm(), true)
  assert.equal(await second.confirm(), false)
  assert.match(rejection, /inattendue/)

  assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_A))
  const learned = await auditRows('ssh_host_key_learned')
  assert.equal(learned.length, 1, 'une seule empreinte réellement apprise → un seul audit')
  assert.equal(learned[0].details.fingerprint, hostKeyFingerprint(KEY_A))
})

test('deux premiers contacts concurrents avec la même clé : tous deux acceptés', { skip: SKIP }, async () => {
  const first = guardFor(), second = guardFor()
  await handshake(first, KEY_A)
  await handshake(second, KEY_A)
  assert.equal(await first.confirm(), true)
  assert.equal(await second.confirm(), true)
  assert.equal((await auditRows('ssh_host_key_learned')).length, 1)
})

test('rekey : comparé à la clé acceptée, sans aller-retour en base', { skip: SKIP }, async () => {
  let dbDown = false
  const db = { query: (...args) => dbDown ? Promise.reject(new Error('base indisponible')) : ctx.db.query(...args) }
  const guard = hostKeyGuard({ db, log: silent }, device)
  assert.equal(await handshake(guard, KEY_A), true)
  assert.equal(await guard.confirm(), true)
  // ssh2 rappelle le vérificateur à chaque rekey : une panne de base ne doit
  // pas couper la session en cours ; une clé différente reste refusée.
  dbDown = true
  assert.equal(await handshake(guard, KEY_A), true)
  dbDown = false
  assert.equal(await handshake(guard, KEY_B), false)
  assert.equal((await auditRows('ssh_host_key_learned')).length, 1)
  assert.equal((await auditRows('ssh_host_key_mismatch')).length, 1)
})

test('empreinte vide ou réduite au préfixe en base : traitée comme absente et réapprise', { skip: SKIP }, async () => {
  for (const blank of ['', '   ', 'SHA256:', 'SHA256: =']) {
    await storeFp(blank)
    const guard = guardFor()
    assert.equal(await handshake(guard, KEY_A), true, JSON.stringify(blank))
    assert.equal(await guard.confirm(), true, JSON.stringify(blank))
    assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_A))
  }
  assert.equal((await auditRows('ssh_host_key_mismatch')).length, 0)
})

test('poste supprimé entre-temps : refusé', { skip: SKIP }, async () => {
  const guard = guardFor()
  assert.equal(await handshake(guard, KEY_A), true)
  await ctx.db.query('DELETE FROM devices WHERE id = $1', [device.id])
  assert.equal(await guard.confirm(), false)
  assert.equal(await handshake(guardFor(), KEY_A), false)
})

test('après réinitialisation, l\'empreinte est réapprise', { skip: SKIP }, async () => {
  await storeFp(hostKeyFingerprint(KEY_A))

  // Réinstallation du poste → l'admin réinitialise depuis la fiche.
  await storeFp(null)

  const guard = guardFor()
  assert.equal(await handshake(guard, KEY_B), true)
  assert.equal(await guard.confirm(), true)
  assert.equal(await loadKnownHostKey(ctx.db, device.id), hostKeyFingerprint(KEY_B))
})
