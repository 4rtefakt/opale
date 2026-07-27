import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSafeLlmUrl, checkSafeLlmUrl, allowedLlmHosts } from '../../lib/safe-url.js'

const NO_ENV = {}

test('accepte les fournisseurs documentés en https', () => {
  assert.equal(assertSafeLlmUrl('https://api.anthropic.com', 'ask.url', NO_ENV), 'https://api.anthropic.com')
  assert.equal(assertSafeLlmUrl('https://api.mistral.ai/', 'ask.url', NO_ENV), 'https://api.mistral.ai')
})

test('accepte le service Ollama interne en http', () => {
  assert.equal(
    assertSafeLlmUrl('http://ollama:11434', 'mail.classifier.url', NO_ENV),
    'http://ollama:11434'
  )
  assert.equal(
    assertSafeLlmUrl('http://localhost:11434/', 'tickets.assistant.url', NO_ENV),
    'http://localhost:11434'
  )
})

test('refuse un hôte hors allowlist — le cas exfiltration de clé API', () => {
  assert.throws(
    () => assertSafeLlmUrl('https://attaquant.example', 'ask.url', NO_ENV),
    /hôte « attaquant\.example » non autorisé/
  )
})

test('refuse http:// vers un hôte externe (clé API en clair sur le réseau)', () => {
  // api.mistral.ai est dans l'allowlist, mais pas en clair.
  assert.throws(
    () => assertSafeLlmUrl('http://api.mistral.ai', 'ask.url', NO_ENV),
    /http:\/\/ refusé/
  )
})

test('refuse les schémas non-HTTP', () => {
  for (const bad of ['file:///etc/passwd', 'gopher://x/', 'ftp://api.mistral.ai/']) {
    assert.throws(() => assertSafeLlmUrl(bad, 'ask.url', NO_ENV), /schéma|non autorisé/)
  }
})

test('refuse les identifiants embarqués dans l\'URL', () => {
  assert.throws(
    () => assertSafeLlmUrl('https://user:pass@api.mistral.ai', 'ask.url', NO_ENV),
    /identifiants dans l'URL/
  )
})

test('refuse une URL vide ou non parsable', () => {
  assert.throws(() => assertSafeLlmUrl('', 'ask.url', NO_ENV), /URL vide/)
  assert.throws(() => assertSafeLlmUrl('   ', 'ask.url', NO_ENV), /URL vide/)
  // Valeurs que le code utilisait comme placeholders avant ce contrôle.
  assert.throws(() => assertSafeLlmUrl('u', 'ask.url', NO_ENV), /URL invalide/)
  assert.throws(() => assertSafeLlmUrl('api.mistral.ai', 'ask.url', NO_ENV), /URL invalide/)
})

test('la comparaison d\'hôte est insensible à la casse et au point final', () => {
  assert.ok(assertSafeLlmUrl('https://API.Mistral.AI/', 'ask.url', NO_ENV))
  assert.ok(assertSafeLlmUrl('https://api.mistral.ai./', 'ask.url', NO_ENV))
})

test('un sous-domaine d\'un hôte autorisé n\'est PAS autorisé', () => {
  assert.throws(
    () => assertSafeLlmUrl('https://evil.api.mistral.ai', 'ask.url', NO_ENV),
    /non autorisé/
  )
  // Et le suffixe collé non plus (anti « api.mistral.ai.evil.tld »).
  assert.throws(
    () => assertSafeLlmUrl('https://api.mistral.ai.evil.tld', 'ask.url', NO_ENV),
    /non autorisé/
  )
})

test('OPALE_LLM_ALLOWED_HOSTS étend l\'allowlist', () => {
  const env = { OPALE_LLM_ALLOWED_HOSTS: 'llm.interne.corp, autre.example' }
  assert.ok(assertSafeLlmUrl('https://llm.interne.corp/v1', 'ask.url', env))
  assert.ok(assertSafeLlmUrl('https://autre.example', 'ask.url', env))
  assert.ok(allowedLlmHosts(env).has('llm.interne.corp'))
  // Les défauts restent présents.
  assert.ok(allowedLlmHosts(env).has('api.anthropic.com'))
})

test('checkSafeLlmUrl renvoie un résultat au lieu de lever', () => {
  const ok = checkSafeLlmUrl('https://api.anthropic.com', 'ask.url', NO_ENV)
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://api.anthropic.com')

  const ko = checkSafeLlmUrl('https://ailleurs.example', 'ask.url', NO_ENV)
  assert.equal(ko.ok, false)
  assert.match(ko.error, /non autorisé/)
})
