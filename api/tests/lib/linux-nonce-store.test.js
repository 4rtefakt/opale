import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNonceStore } from '../../modules/linux/lib/nonce-store.js'

test('seen — première visite, rejeu et expiration exacte sans renouvellement du TTL', () => {
  let time = 0
  const store = createNonceStore({ now: () => time })
  assert.equal(store.has('a'), false)
  assert.equal(store.has('a'), false)
  assert.equal(store.seen('a'), false)
  time = 599_999
  assert.equal(store.has('a'), true)
  assert.equal(store.seen('a'), true)
  time = 600_000
  assert.equal(store.seen('a'), false)
  assert.equal(store.seen('a'), true)
})

test('capacité — éviction du plus ancien, même après une nouvelle consultation', () => {
  const store = createNonceStore({ max: 2 })
  store.seen('a')
  store.seen('b')
  assert.equal(store.seen('a'), true)
  store.seen('c')
  assert.equal(store.has('a'), false)
  assert.equal(store.has('b'), true)
  assert.equal(store.has('c'), true)
})

test('sweep — les consultations périodiques conservent les nonces encore valides', () => {
  let time = 0
  const store = createNonceStore({ ttlMs: 100, now: () => time })
  store.seen('expired')
  time = 50
  store.seen('live')
  time = 100
  for (let i = 0; i < 100; i++) assert.equal(store.has('absent'), false)
  assert.equal(store.has('expired'), false)
  assert.equal(store.seen('live'), true)
  assert.equal(store.seen('expired'), false)
})

test('stores — isolation entre instances', () => {
  const first = createNonceStore()
  const second = createNonceStore()
  first.seen('a')
  assert.equal(second.seen('a'), false)
  assert.equal(first.seen('a'), true)
})
