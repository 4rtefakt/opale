// Ask Opale — abstraction provider (fetch mocké, pas de réseau).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  askProvider, extractJsonObject, extractMistral, extractAnthropic,
} from '../../modules/ask/lib/provider.js'

test('extractJsonObject : JSON nu', () => {
  assert.deepEqual(extractJsonObject('{"resource":"devices"}'), { resource: 'devices' })
})

test('extractJsonObject : fences markdown tolérées', () => {
  assert.deepEqual(extractJsonObject('```json\n{"resource":"tickets"}\n```'), { resource: 'tickets' })
})

test('extractJsonObject : objet noyé dans du texte', () => {
  assert.deepEqual(extractJsonObject('Voici : {"resource":"devices"} voilà'), { resource: 'devices' })
})

test('extractJsonObject : non-JSON → throw', () => {
  assert.throws(() => extractJsonObject('pas du json du tout'), /non-JSON/)
})

test('extractMistral : lit choices[0].message.content', () => {
  const data = { choices: [{ message: { content: '{"resource":"compliance"}' } }] }
  assert.deepEqual(extractMistral(data), { resource: 'compliance' })
})

test('extractAnthropic : lit le bloc tool_use forcé', () => {
  const data = { content: [
    { type: 'text', text: 'ok' },
    { type: 'tool_use', name: 'emit_query_spec', input: { resource: 'devices', filters: { status: 'offline' } } },
  ] }
  assert.deepEqual(extractAnthropic(data), { resource: 'devices', filters: { status: 'offline' } })
})

test('extractAnthropic : pas de tool_use → throw', () => {
  assert.throws(() => extractAnthropic({ content: [{ type: 'text', text: 'rien' }] }), /tool_use/)
})

test('askProvider mistral : endpoint + auth + json_object, retourne le spec', async () => {
  let captured
  const fetchImpl = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"resource":"devices"}' } }] }) }
  }
  const spec = await askProvider({
    provider: 'mistral', key: 'sk-test', model: 'mistral-small-latest',
    question: 'les postes hors ligne', fetchImpl,
  })
  assert.deepEqual(spec, { resource: 'devices' })
  assert.match(captured.url, /\/v1\/chat\/completions$/)
  assert.equal(captured.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(captured.body.response_format, { type: 'json_object' })
  assert.equal(captured.body.messages[0].role, 'system')
})

test('askProvider anthropic : tool forcé, retourne input', async () => {
  let captured
  const fetchImpl = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) }
    return { ok: true, json: async () => ({ content: [
      { type: 'tool_use', name: 'emit_query_spec', input: { resource: 'tickets', filters: { is_open: true } } },
    ] }) }
  }
  const spec = await askProvider({
    provider: 'anthropic', key: 'sk-ant', model: 'claude-haiku-4-5-20251001',
    question: 'tickets ouverts', fetchImpl,
  })
  assert.deepEqual(spec, { resource: 'tickets', filters: { is_open: true } })
  assert.match(captured.url, /\/v1\/messages$/)
  assert.equal(captured.headers['x-api-key'], 'sk-ant')
  assert.equal(captured.body.tool_choice.name, 'emit_query_spec')
})

test('askProvider : arguments manquants → throw', async () => {
  await assert.rejects(() => askProvider({ key: 'k', model: 'm', question: 'q' }), /provider manquant/)
  await assert.rejects(() => askProvider({ provider: 'mistral', model: 'm', question: 'q' }), /clé API manquante/)
  await assert.rejects(() => askProvider({ provider: 'mistral', key: 'k', question: 'q' }), /model manquant/)
  await assert.rejects(() => askProvider({ provider: 'mistral', key: 'k', model: 'm' }), /question vide/)
})

test('askProvider : statut HTTP non-ok → throw avec détail', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' })
  await assert.rejects(
    () => askProvider({ provider: 'mistral', key: 'k', model: 'm', question: 'q', fetchImpl }),
    /mistral 401 — Unauthorized/,
  )
})
