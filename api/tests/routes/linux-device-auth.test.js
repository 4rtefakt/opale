import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import deviceAuthPlugin from '../../modules/linux/plugins/device-auth.js'
import { signRequest } from '../../modules/linux/lib/device-auth.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip device auth'
const target = '/api/linux/agent/_probe'
const body = Buffer.from('{ "value": "été", "extra": true }\n')
let db, release, app, approved, pending, revoked

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  approved = await seedLinuxDeviceKey(db, { status: 'approved' })
  pending  = await seedLinuxDeviceKey(db)
  revoked  = await seedLinuxDeviceKey(db, { status: 'revoked' })
  app = await buildApp({
    db,
    registerAuth: false,
    routes: async f => {
      await f.register(async agent => {
        await deviceAuthPlugin(agent)
        for (const [path, opts] of [
          [target, undefined],
          [target + '-any', { allowStatuses: ['approved', 'pending', 'rejected', 'revoked'] }],
        ]) {
          agent.post(path, {
            preValidation: agent.deviceAuth(opts),
            schema: {
              body: {
                type: 'object',
                properties: { value: { type: 'string', minLength: 1 } },
                additionalProperties: false,
              },
            },
          }, async req => ({ id: req.deviceKey.id, body: req.body }))
        }
        agent.get(target, { preValidation: agent.deviceAuth() }, async req => ({ id: req.deviceKey.id }))
      })
      // Le parser et les décorateurs restent dans le scope agent.
      assert.equal(f.hasDecorator('deviceAuth'), false)
      f.post('/_outside', async req => ({ hasRawBody: Buffer.isBuffer(req.rawBody), body: req.body }))
    },
  })
})

after(async () => {
  if (app) await app.close()
  if (release) await release()
  await closeSharedPool()
})

function signed(key = approved, overrides = {}) {
  return signRequest({ privateKey: key.privateKey, fingerprint: key.fingerprint, method: 'POST', target, body, ...overrides })
}

function inject(headers, payload = body, url = target) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload })
}

function unauthorized(res, code) {
  assert.equal(res.statusCode, 401, res.body)
  assert.equal(res.json().code, code)
  assert.equal(typeof res.json().error, 'string')
}

test('signature valide — octets exacts, deviceKey et validation du body', { skip: SKIP }, async () => {
  const res = await inject(signed())
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { id: approved.id, body: { value: 'été' } })
})

test('signature fausse — 401 sans brûler le nonce', { skip: SKIP }, async () => {
  const headers = signed()
  unauthorized(await inject({ ...headers, 'x-opale-signature': Buffer.alloc(64).toString('base64') }), 'SIGNATURE_INVALID')
  assert.equal((await inject(headers)).statusCode, 200)
})

test('clé inconnue — 401 avant la validation du schéma', { skip: SKIP }, async () => {
  const payload = Buffer.from('{"value":""}')
  unauthorized(await inject(signed(approved, { fingerprint: '00'.repeat(32), body: payload }), payload), 'UNKNOWN_KEY')
})

test('clé pending — refus par défaut, succès avec allowStatuses', { skip: SKIP }, async () => {
  unauthorized(await inject(signed(pending)), 'NOT_APPROVED')
  const url = target + '-any'
  const res = await inject(signed(pending, { target: url }), body, url)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().id, pending.id)
})

test('clé revoked — 401 REVOKED', { skip: SKIP }, async () => {
  unauthorized(await inject(signed(revoked)), 'REVOKED')
})

test('horloge décalée — 401 CLOCK_SKEW et heure serveur', { skip: SKIP }, async () => {
  const before = Math.floor(Date.now() / 1000)
  const res = await inject(signed(approved, { timestamp: before - 600 }))
  unauthorized(res, 'CLOCK_SKEW')
  assert.ok(res.json().server_time >= before)
  assert.ok(res.json().server_time <= Math.floor(Date.now() / 1000))
})

test('nonce rejoué — cache partagé entre les hooks de routes', { skip: SKIP }, async () => {
  const headers = signed()
  assert.equal((await inject(headers)).statusCode, 200)
  unauthorized(await inject(headers), 'NONCE_REPLAY')
  const url = target + '-any'
  unauthorized(await inject(signed(approved, { target: url, nonce: headers['x-opale-nonce'] }), body, url), 'NONCE_REPLAY')
})

test('corps modifié après signature — 401', { skip: SKIP }, async () => {
  unauthorized(await inject(signed(), Buffer.from('{"value":"été","extra":true}')), 'SIGNATURE_INVALID')
})

test('signature valide et corps hors schéma — 400', { skip: SKIP }, async () => {
  const payload = Buffer.from('{"value":""}')
  const res = await inject(signed(approved, { body: payload }), payload)
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(res.json().code, 'FST_ERR_VALIDATION')
})

test('query string — signature sur une autre cible refusée', { skip: SKIP }, async () => {
  unauthorized(await inject(signed(approved, { target: target + '?x=%2F' }), body, target + '?x=/'), 'SIGNATURE_INVALID')
  const url = target + '?x=%2F&x=2'
  assert.equal((await inject(signed(approved, { target: url }), body, url)).statusCode, 200)
})

test('corps vide JSON et requête sans corps — hash de zéro octet', { skip: SKIP }, async () => {
  const payload = Buffer.alloc(0)
  const res = await inject(signed(approved, { body: payload }), payload)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().body, {})
  const get = await app.inject({ method: 'GET', url: target, headers: signed(approved, { method: 'GET', body: payload }) })
  assert.equal(get.statusCode, 200, get.body)
})

test('JSON mal formé — erreur de parsing 400', { skip: SKIP }, async () => {
  const payload = Buffer.from('{')
  assert.equal((await inject(signed(approved, { body: payload }), payload)).statusCode, 400)
})

test('encapsulation — le parser JSON des autres routes reste inchangé', { skip: SKIP }, async () => {
  const res = await app.inject({ method: 'POST', url: '/_outside', payload: { value: 'ok' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { hasRawBody: false, body: { value: 'ok' } })
})
