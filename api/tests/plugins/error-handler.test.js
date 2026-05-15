// Tests unitaires du plugin error-handler (api/plugins/error-handler.js).
// Instancie un Fastify minimal avec le plugin + des routes de test qui
// throwent dans différentes conditions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import errorHandlerPlugin from '../../plugins/error-handler.js'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(errorHandlerPlugin)

  app.get('/boom-500', () => { throw new Error('kaboom') })

  app.get('/boom-400', () => {
    const err = new Error('champ requis manquant')
    err.statusCode = 400
    throw err
  })

  app.get('/boom-404', () => {
    const err = new Error('ressource introuvable')
    err.statusCode = 404
    throw err
  })

  app.post('/schema-route', {
    schema: { body: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } }
  }, async () => ({ ok: true }))

  app.get('/boom-nan-statuscode', () => {
    const err = new Error('oops')
    err.statusCode = 'not-a-number'
    throw err
  })

  await app.ready()
  return app
}

test('500 sur throw générique → { error: "Erreur interne" }', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/boom-500' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'Erreur interne' })
  await app.close()
})

test('400 avec err.statusCode = 400 → { error: "<message>" }', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/boom-400' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'champ requis manquant' })
  await app.close()
})

test('404 avec err.statusCode = 404 → { error: "<message>" }', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/boom-404' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'ressource introuvable' })
  await app.close()
})

test('erreur validation Fastify (body required) → 400 + { error: "...x..." }', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'POST', url: '/schema-route', payload: {} })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.ok(typeof body.error === 'string', 'error doit être une string')
  assert.match(body.error, /x/, 'le message doit mentionner le champ manquant')
  await app.close()
})

test('statusCode non-numérique → fallback 500 + message générique', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/boom-nan-statuscode' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'Erreur interne' })
  await app.close()
})
