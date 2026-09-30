import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'

function clockedStore() {
  let clock = 1_000_000
  const store = createGitTokenStore({ now: () => clock, sweepMs: 60_000 })
  return { store, advance: ms => { clock += ms } }
}

test('token git : format gt_ + 40 hex, vérification renvoie le lien device sans le token', () => {
  const { store } = clockedStore()
  const { token, expiresAt } = store.create({ deviceId: 'dev-1', fingerprint: 'ab'.repeat(32), ttlMs: 600_000 })
  assert.match(token, /^gt_[0-9a-f]{40}$/)
  assert.equal(expiresAt, 1_600_000)
  assert.deepEqual(store.verify(token), { deviceId: 'dev-1', fingerprint: 'ab'.repeat(32), expiresAt, expired: false })
  assert.equal(store.size(), 1)
  store.stop()
})

test('token git : inconnu, mal formé ou vide → null', () => {
  const { store } = clockedStore()
  store.create({ deviceId: 'dev-1', fingerprint: 'f', ttlMs: 1000 })
  assert.equal(store.verify('gt_' + '0'.repeat(40)), null)
  assert.equal(store.verify('gt_court'), null)
  assert.equal(store.verify(''), null)
  assert.equal(store.verify(undefined), null)
  store.stop()
})

test('token git : expiré → signalé une fois puis retiré', () => {
  const { store, advance } = clockedStore()
  const { token } = store.create({ deviceId: 'dev-1', fingerprint: 'f', ttlMs: 1000 })
  advance(999)
  assert.equal(store.verify(token).expired, false)
  advance(1)
  assert.equal(store.verify(token).expired, true)
  assert.equal(store.verify(token), null)
  assert.equal(store.size(), 0)
  store.stop()
})

test('token git : révocation par device et balayage des entrées périmées', () => {
  const { store, advance } = clockedStore()
  const a = store.create({ deviceId: 'dev-a', fingerprint: 'a', ttlMs: 1000 })
  const b = store.create({ deviceId: 'dev-b', fingerprint: 'b', ttlMs: 5000 })
  store.create({ deviceId: 'dev-a', fingerprint: 'a', ttlMs: 5000 })
  store.revokeDevice('dev-a')
  assert.equal(store.verify(a.token), null)
  assert.equal(store.size(), 1)
  advance(6000)
  assert.equal(store.size(), 0)
  assert.equal(store.verify(b.token), null)
  store.stop()
})
