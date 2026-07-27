import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pMap } from '../../lib/p-map.js'

test('traite tous les éléments et préserve l\'ordre des entrées', async () => {
  const items = [10, 1, 5, 2, 8]
  // Les durées sont inversées par rapport à l'ordre : si le résultat suivait
  // l'ordre d'ACHÈVEMENT, il serait trié différemment.
  const out = await pMap(items, async (n) => {
    await new Promise(r => setTimeout(r, n))
    return n * 2
  }, 2)
  assert.deepEqual(out, [20, 2, 10, 4, 16])
})

test('ne dépasse jamais la concurrence demandée', async () => {
  let running = 0, peak = 0
  await pMap(Array.from({ length: 50 }, (_, i) => i), async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
  }, 4)
  assert.equal(peak, 4, `pic de concurrence observé : ${peak}`)
})

test('traite bien la TOTALITÉ des éléments malgré la borne', async () => {
  const seen = []
  await pMap(Array.from({ length: 200 }, (_, i) => i), async (n) => { seen.push(n) }, 10)
  assert.equal(seen.length, 200)
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i))
})

test('liste vide : ne lance rien', async () => {
  let calls = 0
  const out = await pMap([], async () => { calls++ }, 10)
  assert.deepEqual(out, [])
  assert.equal(calls, 0)
})

test('concurrence supérieure au nombre d\'éléments : pas de worker inutile', async () => {
  let peak = 0, running = 0
  await pMap([1, 2], async () => {
    running++; peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
  }, 100)
  assert.equal(peak, 2)
})

test('concurrence 0 ou négative est ramenée à 1', async () => {
  let peak = 0, running = 0
  await pMap([1, 2, 3], async () => {
    running++; peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
  }, 0)
  assert.equal(peak, 1)
})

test('une erreur remonte à l\'appelant', async () => {
  await assert.rejects(
    () => pMap([1, 2, 3], async (n) => { if (n === 2) throw new Error('boom') }, 2),
    /boom/
  )
})

test('passe l\'index en second argument', async () => {
  const out = await pMap(['a', 'b', 'c'], async (v, i) => `${i}:${v}`, 2)
  assert.deepEqual(out, ['0:a', '1:b', '2:c'])
})
