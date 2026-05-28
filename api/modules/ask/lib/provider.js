// Ask Opale — abstraction provider (Mistral / Anthropic) en structured-output.
//
// Primitive unique : question FR → objet QuerySpec brut (non encore validé).
// On encapsule les deux formats de fil :
//   - Mistral  : /v1/chat/completions + response_format json_object
//   - Anthropic: /v1/messages + tool forcé (tool_choice) → sortie structurée
//
// La validation sémantique reste côté serveur (queryspec.js) : ce module ne
// fait QUE l'appel + l'extraction du JSON. `fetchImpl` injectable (tests sans
// réseau, comme classify.js / assistant.js). Les helpers d'extraction sont
// exportés pour être testés unitairement.

import { buildSystemPrompt, buildUserPrompt, QUERYSPEC_JSON_SCHEMA } from './prompt.js'

const DEFAULT_URLS = {
  mistral:   'https://api.mistral.ai',
  anthropic: 'https://api.anthropic.com',
}
const TOOL_NAME = 'emit_query_spec'

// Parse une chaîne supposée JSON, tolérante aux fences markdown ```json … ```.
export function extractJsonObject(str) {
  if (typeof str !== 'string') throw new Error('provider: contenu non textuel')
  let s = str.trim()
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(s)
  } catch {
    // Dernier recours : isoler le premier objet {...} équilibré grossièrement.
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)) } catch { /* fallthrough */ }
    }
    throw new Error('provider: réponse non-JSON')
  }
}

// Extrait le QuerySpec d'une réponse Mistral chat/completions.
export function extractMistral(data) {
  const content = data?.choices?.[0]?.message?.content
  return extractJsonObject(content)
}

// Extrait le QuerySpec d'une réponse Anthropic messages (tool_use forcé).
export function extractAnthropic(data) {
  const block = Array.isArray(data?.content)
    ? data.content.find(b => b?.type === 'tool_use' && b?.name === TOOL_NAME)
    : null
  if (!block || typeof block.input !== 'object') {
    throw new Error('provider: pas de tool_use exploitable dans la réponse')
  }
  return block.input
}

function buildRequest({ provider, url, key, model, question }) {
  const system = buildSystemPrompt()
  const user = buildUserPrompt(question)
  const base = (url || DEFAULT_URLS[provider] || '').replace(/\/$/, '')

  if (provider === 'mistral') {
    return {
      endpoint: `${base}/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
      },
      extract: extractMistral,
    }
  }

  if (provider === 'anthropic') {
    return {
      endpoint: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 1024,
        // Le catalogue (system) est statique → prompt caching : on évite de
        // re-facturer/re-traiter ces tokens à chaque requête (gros gain coût +
        // latence, et soulage les rate limits "input tokens/min").
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: [{
          name: TOOL_NAME,
          description: 'Émet le QuerySpec structuré correspondant à la question.',
          input_schema: QUERYSPEC_JSON_SCHEMA,
        }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: user }],
      },
      extract: extractAnthropic,
    }
  }

  throw new Error(`provider inconnu : ${provider}`)
}

export async function askProvider({
  provider, url, key, model, question,
  fetchImpl = fetch, timeoutMs = 20_000,
} = {}) {
  if (!provider) throw new Error('askProvider: provider manquant')
  if (!key)      throw new Error('askProvider: clé API manquante')
  if (!model)    throw new Error('askProvider: model manquant')
  if (!question || !String(question).trim()) throw new Error('askProvider: question vide')

  const { endpoint, headers, body, extract } = buildRequest({ provider, url, key, model, question })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${provider} ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const data = await res.json()
  return extract(data)
}
