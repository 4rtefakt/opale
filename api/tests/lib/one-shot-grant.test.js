// api/lib/one-shot-grant.js — tests unitaires
//
// 9 cas couverts : nonce format, happy path, nonce manquant, nonce inconnu,
// one-shot, expiration, size(), cleanup auto setTimeout, isolation entre stores.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createGrantStore } from '../../modules/remote/lib/one-shot-grant.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. create retourne nonce hex 64 chars + expires_in
test('create — retourne nonce hex 64 chars + expires_in en secondes', () => {
  const store = createGrantStore({ ttlMs: 30_000 })
  const { nonce, expires_in } = store.create({ deviceId: 'dev-1' })
  assert.match(nonce, /^[0-9a-f]{64}$/)
  assert.equal(expires_in, 30)
})

// 2. create + consume happy path
test('create + consume — retourne le payload complet', () => {
  const store = createGrantStore()
  const payload = { deviceId: 'dev-2', reason: 'test', identity: { entraId: 'e1' } }
  const { nonce } = store.create(payload)
  const result = store.consume(nonce)
  assert.equal(result.ok, true)
  assert.equal(result.grant.deviceId, 'dev-2')
  assert.equal(result.grant.reason, 'test')
  assert.equal(result.grant.identity.entraId, 'e1')
  assert.ok(result.grant.expiresAt > Date.now())
})

// 3. consume sans nonce
test('consume — sans nonce → { ok: false, error: "Nonce manquant" }', () => {
  const store = createGrantStore()
  assert.deepEqual(store.consume(undefined), { ok: false, error: 'Nonce manquant' })
  assert.deepEqual(store.consume(''), { ok: false, error: 'Nonce manquant' })
  assert.deepEqual(store.consume(null), { ok: false, error: 'Nonce manquant' })
  assert.deepEqual(store.consume(42), { ok: false, error: 'Nonce manquant' })
})

// 4. consume nonce inconnu
test('consume — nonce inconnu → { ok: false, error: "Nonce invalide ou déjà utilisé" }', () => {
  const store = createGrantStore()
  const result = store.consume('0'.repeat(64))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Nonce invalide ou déjà utilisé')
})

// 5. one-shot — second consume échoue
test('one-shot — second consume retourne "Nonce invalide ou déjà utilisé"', () => {
  const store = createGrantStore()
  const { nonce } = store.create({ deviceId: 'dev-5' })
  const first = store.consume(nonce)
  assert.equal(first.ok, true)
  const second = store.consume(nonce)
  assert.equal(second.ok, false)
  assert.equal(second.error, 'Nonce invalide ou déjà utilisé')
})

// 6. expiration — utilise mock.timers pour avancer Date.now uniquement,
//    sans déclencher le setTimeout de cleanup (évite la course cleanup vs consume).
test('expiration — consume après ttlMs retourne "Nonce expiré"', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const store = createGrantStore({ ttlMs: 100 })
  const { nonce } = store.create({ deviceId: 'dev-6' })
  // Avance Date.now de 200ms → expiresAt dépassé. Le cleanup setTimeout
  // n'est pas mocké donc ne s'est pas déclenché : l'entrée est encore dans la Map.
  t.mock.timers.tick(200)
  const result = store.consume(nonce)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Nonce expiré')
  t.mock.timers.reset()
})

// 7. size() reflète le nombre de grants actifs
test('size() — reflète correctement le nombre de grants actifs', () => {
  const store = createGrantStore()
  assert.equal(store.size(), 0)
  const { nonce: n1 } = store.create({ x: 1 })
  assert.equal(store.size(), 1)
  const { nonce: n2 } = store.create({ x: 2 })
  assert.equal(store.size(), 2)
  store.consume(n1)
  assert.equal(store.size(), 1)
  store.consume(n2)
  assert.equal(store.size(), 0)
})

// 8. cleanup auto setTimeout — après ttlMs + délai, size() est 0 sans consume.
// .unref() garantit que le test runner ne reste pas bloqué à attendre ce timer.
test('cleanup auto setTimeout — size() = 0 après expiration sans consume', async () => {
  const store = createGrantStore({ ttlMs: 20 })
  store.create({ x: 1 })
  store.create({ x: 2 })
  assert.equal(store.size(), 2)
  await sleep(50)  // bien au-delà de ttlMs=20ms
  assert.equal(store.size(), 0)
})

// 9. isolation entre stores — deux stores indépendants ne partagent pas leurs grants
test('isolation — deux stores ne partagent pas leurs grants', () => {
  const storeA = createGrantStore()
  const storeB = createGrantStore()
  const { nonce } = storeA.create({ source: 'A' })
  // consommer le nonce dans B doit échouer
  const result = storeB.consume(nonce)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Nonce invalide ou déjà utilisé')
  // consommer dans A doit réussir
  const resultA = storeA.consume(nonce)
  assert.equal(resultA.ok, true)
  assert.equal(resultA.grant.source, 'A')
})
