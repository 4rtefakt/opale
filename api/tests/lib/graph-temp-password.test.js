// Mot de passe temporaire des comptes Entra créés par l'onboarding
// (core/lib/graph.js → tempPassword). Doit sortir d'un CSPRNG (jamais
// Math.random) et respecter la complexité Entra (3 catégories sur 4 : on en
// garantit 4) avec l'alphabet historique sans caractères ambigus.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

import { tempPassword } from '../../modules/core/lib/graph.js'

const UPPER = /[ABCDEFGHJKLMNPQRSTUVWXYZ]/
const LOWER = /[abcdefghjkmnpqrstuvwxyz]/
const DIGIT = /[23456789]/
const SYMB  = /[!@#$]/
const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$]+$/

test('tempPassword : n\'utilise jamais Math.random', () => {
  const spy = mock.method(Math, 'random', () => { throw new Error('Math.random interdit') })
  try {
    assert.doesNotThrow(() => tempPassword())
    assert.equal(spy.mock.callCount(), 0)
  } finally {
    spy.mock.restore()
  }
})

test('tempPassword : 14 caractères, alphabet historique, 4 catégories toujours présentes', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const p = tempPassword()
    assert.equal(p.length, 14)
    assert.match(p, ALPHABET)
    for (const re of [UPPER, LOWER, DIGIT, SYMB]) assert.match(p, re, `${p} : catégorie ${re} absente`)
    seen.add(p)
  }
  assert.equal(seen.size, 2000, 'aucune collision attendue')
})
