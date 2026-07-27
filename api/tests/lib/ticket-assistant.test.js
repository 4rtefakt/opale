// lib/assistant.js — génération de suggestion IA via Ollama (mock fetch).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { generateSuggestion, buildAssistantPrompt } from '../../modules/tickets/lib/assistant.js'

test('buildAssistantPrompt : inclut titre, description et échanges', () => {
  const p = buildAssistantPrompt({
    title: 'Imprimante HS', description: 'Ne répond plus',
    messages: [{ author: 'Marie', content: 'Voyant rouge' }],
  })
  assert.match(p, /Imprimante HS/)
  assert.match(p, /Ne répond plus/)
  assert.match(p, /Marie : Voyant rouge/)
})

test('buildAssistantPrompt : inclut le contexte diagnostic (poste, demandeur, tags, priorité)', () => {
  const p = buildAssistantPrompt({
    title: 'VPN', priority: 'high', status: 'in_progress',
    device: 'PC-MARIE · Windows 11 · Latitude 5540',
    requester: 'Marie Durand, Chercheuse, Pôle lagunes',
    tags: ['Réseau', 'VPN'],
  })
  assert.match(p, /Priorité : high/)
  assert.match(p, /Statut : in_progress/)
  assert.match(p, /PC-MARIE/)
  assert.match(p, /Marie Durand/)
  assert.match(p, /Réseau, VPN/)
})

test('generateSuggestion : utilise le systemPrompt fourni (override)', async () => {
  let captured
  const fetchImpl = async (_url, opts) => {
    captured = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) }
  }
  await generateSuggestion({
    title: 'T', url: 'http://ollama:11434', model: 'm', fetchImpl,
    systemPrompt: 'PROMPT PERSONNALISÉ XYZ',
  })
  assert.equal(captured.messages[0].role, 'system')
  assert.match(captured.messages[0].content, /PROMPT PERSONNALISÉ XYZ/)
})

test('generateSuggestion : systemPrompt vide → fallback défaut', async () => {
  let captured
  const fetchImpl = async (_url, opts) => {
    captured = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) }
  }
  await generateSuggestion({ title: 'T', url: 'http://ollama:11434', model: 'm', fetchImpl, systemPrompt: '   ' })
  assert.match(captured.messages[0].content, /support informatique interne/)
})

test('generateSuggestion : appelle Ollama /api/chat et retourne le texte', async () => {
  let captured
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) }
    return { ok: true, json: async () => ({ message: { content: '  Vérifiez le câble réseau.  ' } }) }
  }
  const out = await generateSuggestion({
    title: 'T', description: 'D', messages: [], url: 'http://ollama:11434', model: 'qwen2.5:3b', fetchImpl,
  })
  assert.equal(out, 'Vérifiez le câble réseau.', 'texte trimmé')
  assert.match(captured.url, /\/api\/chat$/)
  assert.equal(captured.body.model, 'qwen2.5:3b')
  assert.equal(captured.body.stream, false)
})

test('generateSuggestion : url/model manquant → throw', async () => {
  await assert.rejects(() => generateSuggestion({ model: 'x', fetchImpl: async () => ({}) }), /url manquante/)
  await assert.rejects(() => generateSuggestion({ url: 'http://ollama:11434', fetchImpl: async () => ({}) }), /model manquant/)
})

test('generateSuggestion : réponse vide → throw', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: { content: '' } }) })
  await assert.rejects(
    () => generateSuggestion({ title: 'T', url: 'http://ollama:11434', model: 'm', fetchImpl }),
    /réponse vide/
  )
})

test('generateSuggestion : Ollama 500 → throw', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 })
  await assert.rejects(
    () => generateSuggestion({ title: 'T', url: 'http://ollama:11434', model: 'm', fetchImpl }),
    /Ollama 500/
  )
})
