import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceRateLimiter } from '../../modules/linux/lib/device-rate.js'

function clocked(options) {
  let clock = 1_000_000
  const limiter = createDeviceRateLimiter({ now: () => clock, ...options })
  return { limiter, advance: ms => { clock += ms } }
}

test('limite par device : fenêtre glissante, refus non compté, délai avant réessai exact', () => {
  const { limiter, advance } = clocked({ max: 3, windowMs: 1000 })
  assert.deepEqual(limiter.hit('a'), { ok: true, remaining: 2 })
  advance(100)
  assert.deepEqual(limiter.hit('a'), { ok: true, remaining: 1 })
  advance(100)
  assert.deepEqual(limiter.hit('a'), { ok: true, remaining: 0 })
  // 4e passage à t+300 : le plus ancien (t) expire à t+1000.
  advance(100)
  assert.deepEqual(limiter.hit('a'), { ok: false, retry_after_ms: 700 })
  assert.deepEqual(limiter.hit('a'), { ok: false, retry_after_ms: 700 }, 'un refus ne consomme rien')
  // Autre device : compteur distinct.
  assert.equal(limiter.hit('b').ok, true)
  advance(700)
  assert.deepEqual(limiter.hit('a'), { ok: true, remaining: 0 }, 'le premier passage est sorti de la fenêtre')
})

test('limite par device : les entrées vides sont balayées quand la table est pleine', () => {
  const { limiter, advance } = clocked({ max: 1, windowMs: 1000, maxEntries: 2 })
  limiter.hit('a')
  limiter.hit('b')
  assert.equal(limiter.size(), 2)
  advance(1001)
  // Table pleine, device inconnu : balayage des passages périmés avant insertion.
  assert.equal(limiter.hit('c').ok, true)
  assert.equal(limiter.size(), 1)
  assert.equal(limiter.hit('a').ok, true, 'a repart de zéro')
})
