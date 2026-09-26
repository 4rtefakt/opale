// lib/rate-limit.js : parsing de TRUST_PROXY, clés de rate-limit, et effet
// de trustProxy sur req.ip (IP réelle du client derrière le reverse proxy).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { parseTrustProxy, rateLimitKey, ipOnlyKey } from '../../lib/rate-limit.js'

test('parseTrustProxy — désactivé par défaut', () => {
  for (const v of [undefined, null, '', '  ', 'false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(parseTrustProxy(v), false, JSON.stringify(v))
  }
})

test('parseTrustProxy — booléen, liste d\'IP/CIDR', () => {
  assert.equal(parseTrustProxy('true'), true)
  assert.deepEqual(parseTrustProxy('127.0.0.1'), ['127.0.0.1'])
  assert.deepEqual(parseTrustProxy(' 172.16.0.0/12 , 10.0.0.1,::1 '), ['172.16.0.0/12', '10.0.0.1', '::1'])
  assert.deepEqual(parseTrustProxy('loopback,uniquelocal'), ['loopback', 'uniquelocal'])
  assert.deepEqual(parseTrustProxy('fd00::/8'), ['fd00::/8'])
})

test('parseTrustProxy — nombre de sauts refusé au boot (ne vérifie pas le pair TCP)', () => {
  // Fastify ≥ 5.12 traite un trustProxy numérique comme « aucun proxy de
  // confiance » (GHSA-3m5p-2c4r-xxw2) : l'accepter rendrait TRUST_PROXY=1
  // silencieusement inopérant, et avant 5.12 il permettait de forger l'IP.
  for (const v of ['1', '2', '10']) {
    assert.throws(() => parseTrustProxy(v), /nombre de proxies n'est pas sûr/, v)
  }
})

test('parseTrustProxy — valeur invalide → erreur au boot', () => {
  for (const v of ['caddy', '10.0.0.0/33', '10.0.0.1/abc', '1.2.3', 'true,1.2.3.4', '::1/129', ',']) {
    assert.throws(() => parseTrustProxy(v), /TRUST_PROXY invalide/, v)
  }
})

test('rateLimitKey / ipOnlyKey — le Bearer ne compte que pour la clé par défaut', () => {
  const req = (auth) => ({ ip: '198.51.100.7', headers: auth ? { authorization: auth } : {} })
  assert.equal(rateLimitKey(req()), '198.51.100.7')
  assert.match(rateLimitKey(req('Bearer abc')), /^198\.51\.100\.7\|[0-9a-f]{16}$/)
  assert.notEqual(rateLimitKey(req('Bearer abc')), rateLimitKey(req('Bearer abd')))
  assert.equal(ipOnlyKey(req('Bearer abc')), '198.51.100.7')
  assert.equal(ipOnlyKey(req('Bearer abd')), '198.51.100.7')
})

async function ipSeenBy(trustProxy, { remoteAddress, xff }) {
  const app = Fastify({ logger: false, trustProxy })
  app.get('/ip', async (req) => ({ ip: req.ip }))
  await app.ready()
  const res = await app.inject({
    method: 'GET', url: '/ip', remoteAddress,
    headers: xff ? { 'x-forwarded-for': xff } : {},
  })
  await app.close()
  return res.json().ip
}

test('trustProxy — sans réglage, X-Forwarded-For est ignoré (IP du pair TCP)', async () => {
  const ip = await ipSeenBy(parseTrustProxy(undefined), { remoteAddress: '172.18.0.1', xff: '203.0.113.5' })
  assert.equal(ip, '172.18.0.1')
})

test('trustProxy — proxy de confiance : IP réelle du client', async () => {
  // Proxy listé : on lit X-Forwarded-For.
  assert.equal(
    await ipSeenBy(parseTrustProxy('172.16.0.0/12'), { remoteAddress: '172.18.0.1', xff: '203.0.113.5' }),
    '203.0.113.5'
  )
  // Pair non listé (accès direct au port de l'API) : X-Forwarded-For ignoré,
  // un client ne peut pas usurper une IP.
  assert.equal(
    await ipSeenBy(parseTrustProxy('172.16.0.0/12'), { remoteAddress: '198.51.100.9', xff: '203.0.113.5' }),
    '198.51.100.9'
  )
  // Plusieurs entrées : seule la dernière (ajoutée par le proxy de confiance)
  // est retenue, pas celle injectée par le client.
  assert.equal(
    await ipSeenBy(parseTrustProxy('172.16.0.0/12'), { remoteAddress: '172.18.0.1', xff: '6.6.6.6, 203.0.113.5' }),
    '203.0.113.5'
  )
})
