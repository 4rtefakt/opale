// Tests du classifieur d'intent (Phase 2, issue #8).
//
// On valide :
//   - validateClassifierOutput : tous les chemins du parser (intent valide /
//     invalide, confidence borné, reason tronqué)
//   - classifyWithOllama : 3 intents possibles + 3 modes d'échec (HTTP non-OK,
//     JSON malformé, format de sortie non conforme).
//
// L'appel HTTP est mocké via injection de `fetchImpl` — pas de réseau,
// donc pas de flakiness. CLAUDE.md §5 : tests sur la logique critique, pas
// sur la wrapper HTTP.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateClassifierOutput,
  classifyWithOllama,
} from '../../modules/email-bridge/lib/classify.js'

// Construit un fetchImpl qui retourne un message Ollama avec content JSON.
function mockOllama(responseBody, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok, status,
    json: async () => responseBody,
  })
}

// ── validateClassifierOutput ──────────────────────────────────────────────────

test('validate : intent connu, confidence/reason présents', () => {
  const out = validateClassifierOutput({ intent: 'new_ticket', confidence: 0.9, reason: 'demande imprimante' })
  assert.deepEqual(out, { intent: 'new_ticket', confidence: 0.9, reason: 'demande imprimante' })
})

test('validate : intent inconnu → null', () => {
  assert.equal(validateClassifierOutput({ intent: 'spam', confidence: 0.5 }), null)
  assert.equal(validateClassifierOutput({ intent: '',     confidence: 0.5 }), null)
  assert.equal(validateClassifierOutput({}), null)
})

test('validate : null/undefined/non-objet → null', () => {
  assert.equal(validateClassifierOutput(null), null)
  assert.equal(validateClassifierOutput(undefined), null)
  assert.equal(validateClassifierOutput('reply'), null)
  assert.equal(validateClassifierOutput(42), null)
})

test('validate : confidence hors bornes → clampé', () => {
  assert.equal(validateClassifierOutput({ intent: 'reply', confidence: -5    }).confidence, 0)
  assert.equal(validateClassifierOutput({ intent: 'reply', confidence: 999   }).confidence, 1)
  assert.equal(validateClassifierOutput({ intent: 'reply', confidence: 'bof' }).confidence, 0.5)
})

test('validate : reason non-string → vide', () => {
  assert.equal(validateClassifierOutput({ intent: 'other', confidence: 1, reason: 123 }).reason, '')
  assert.equal(validateClassifierOutput({ intent: 'other', confidence: 1                }).reason, '')
})

test('validate : reason tronqué à 500 chars', () => {
  const long = 'x'.repeat(2000)
  assert.equal(validateClassifierOutput({ intent: 'other', confidence: 1, reason: long }).reason.length, 500)
})

// ── classifyWithOllama : happy paths ─────────────────────────────────────────

test('classify : new_ticket', async () => {
  const fetchImpl = mockOllama({ message: { content: JSON.stringify({
    intent: 'new_ticket', confidence: 0.95, reason: 'demande d\'aide imprimante',
  }) } })
  const out = await classifyWithOllama(
    { from: 'marie@example.com', subject: 'Imprimante bloque', bodyPreview: 'Encore bloquée' },
    { url: 'http://localhost:11434', model: 'mistral', fetchImpl }
  )
  assert.equal(out.intent, 'new_ticket')
  assert.equal(out.confidence, 0.95)
  assert.match(out.reason, /imprimante/i)
})

test('classify : reply', async () => {
  const fetchImpl = mockOllama({ message: { content: '{"intent":"reply","confidence":0.8,"reason":"répond à ma question"}' } })
  const out = await classifyWithOllama(
    { from: 'marie@example.com', subject: 'Re: imprimante', bodyPreview: 'Oui ça marche maintenant' },
    { url: 'http://localhost:11434/', model: 'mistral', fetchImpl }
  )
  assert.equal(out.intent, 'reply')
})

test('classify : other', async () => {
  const fetchImpl = mockOllama({ message: { content: '{"intent":"other","confidence":0.7,"reason":"newsletter"}' } })
  const out = await classifyWithOllama(
    { from: 'newsletter@example.com', subject: 'Notre actu du mois', bodyPreview: 'Bonjour à tous' },
    { url: 'http://localhost:11434', model: 'mistral', fetchImpl }
  )
  assert.equal(out.intent, 'other')
})

// ── classifyWithOllama : modes d'échec ───────────────────────────────────────

test('classify : Ollama HTTP non-OK → throw', async () => {
  const fetchImpl = mockOllama({}, { ok: false, status: 500 })
  await assert.rejects(
    () => classifyWithOllama({ from: 'x@y' }, { url: 'http://x', model: 'm', fetchImpl }),
    /Ollama 500/
  )
})

test('classify : content non-JSON → throw', async () => {
  const fetchImpl = mockOllama({ message: { content: 'pas du json' } })
  await assert.rejects(
    () => classifyWithOllama({ from: 'x@y' }, { url: 'http://x', model: 'm', fetchImpl }),
    /non-JSON/
  )
})

test('classify : format sortie non conforme → throw', async () => {
  const fetchImpl = mockOllama({ message: { content: '{"intent":"spam","confidence":1}' } })
  await assert.rejects(
    () => classifyWithOllama({ from: 'x@y' }, { url: 'http://x', model: 'm', fetchImpl }),
    /format de sortie invalide/
  )
})

test('classify : url manquante → throw avant fetch', async () => {
  await assert.rejects(
    () => classifyWithOllama({ from: 'x@y' }, { url: '', model: 'm' }),
    /url manquante/
  )
})

test('classify : model manquant → throw avant fetch', async () => {
  await assert.rejects(
    () => classifyWithOllama({ from: 'x@y' }, { url: 'http://x', model: '' }),
    /model manquant/
  )
})
