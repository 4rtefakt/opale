import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import securityHeadersPlugin, { buildSecurityHeaders, CSP } from '../../plugins/security-headers.js'

async function appWith(env) {
  const prev = process.env.NODE_ENV
  if (env?.NODE_ENV !== undefined) process.env.NODE_ENV = env.NODE_ENV
  const f = Fastify({ logger: false })
  await f.register(securityHeadersPlugin)
  f.get('/api/quelquechose', async () => ({ ok: true }))
  f.get('/api/casse', async () => { throw new Error('boum') })
  f.get('/api/csp-custom', async (req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'none'")
    return { ok: true }
  })
  await f.ready()
  return { f, restore: () => { process.env.NODE_ENV = prev } }
}

test('la CSP couvre les réponses d\'API, pas seulement le static', async () => {
  const { f, restore } = await appWith({})
  const res = await f.inject({ method: 'GET', url: '/api/quelquechose' })
  assert.equal(res.headers['content-security-policy'], CSP)
  await f.close(); restore()
})

test('la CSP restreint script-src à self et interdit object/base-uri', async () => {
  // C'est la directive qui compte : le front pose ~300 innerHTML interpolés à
  // la main, donc script-src détermine l'impact d'un esc() oublié.
  assert.match(CSP, /script-src 'self'/)
  assert.match(CSP, /object-src 'none'/)
  assert.match(CSP, /base-uri 'none'/)
  assert.match(CSP, /frame-ancestors 'self'/)
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/)
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-eval/)
})

test('les autres en-têtes sont présents', async () => {
  const { f, restore } = await appWith({})
  const res = await f.inject({ method: 'GET', url: '/api/quelquechose' })
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin')
  assert.match(res.headers['permissions-policy'], /camera=\(\)/)
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin')
  await f.close(); restore()
})

test('les en-têtes couvrent aussi les réponses d\'erreur', async () => {
  // Une 500 est une réponse comme une autre : elle doit porter la même CSP.
  const { f, restore } = await appWith({})
  const res = await f.inject({ method: 'GET', url: '/api/casse' })
  assert.equal(res.statusCode, 500)
  assert.equal(res.headers['content-security-policy'], CSP)
  await f.close(); restore()
})

test('les en-têtes couvrent les 404', async () => {
  const { f, restore } = await appWith({})
  const res = await f.inject({ method: 'GET', url: '/api/inexistant' })
  assert.equal(res.statusCode, 404)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  await f.close(); restore()
})

test('une route qui pose sa propre CSP garde la main', async () => {
  const { f, restore } = await appWith({})
  const res = await f.inject({ method: 'GET', url: '/api/csp-custom' })
  assert.equal(res.headers['content-security-policy'], "default-src 'none'")
  await f.close(); restore()
})

test('HSTS seulement en production', () => {
  // En dev l'API est servie en clair sur localhost : un HSTS posé là
  // épinglerait le navigateur sur https pour TOUT localhost, y compris les
  // autres projets du poste.
  assert.equal(buildSecurityHeaders({ NODE_ENV: 'development' })['Strict-Transport-Security'], undefined)
  assert.equal(buildSecurityHeaders({})['Strict-Transport-Security'], undefined)

  const prod = buildSecurityHeaders({ NODE_ENV: 'production' })
  assert.match(prod['Strict-Transport-Security'], /max-age=31536000/)
  assert.match(prod['Strict-Transport-Security'], /includeSubDomains/)
})

test('HSTS désactivable explicitement en production', () => {
  // Utile derrière un proxy qui pose déjà l'en-tête, ou pendant une bascule
  // de domaine où un HSTS trop large bloquerait.
  const h = buildSecurityHeaders({ NODE_ENV: 'production', OPALE_DISABLE_HSTS: 'true' })
  assert.equal(h['Strict-Transport-Security'], undefined)
})
