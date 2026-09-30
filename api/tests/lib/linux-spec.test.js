import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import linux, { SPEC_COMPLETE } from '../../modules/linux/index.js'
import { loadSpec, deref, schemaFor, operations, auditActions } from '../../modules/linux/lib/spec.js'

test('spec Linux : chargement mémorisé et métadonnées des opérations fidèles au YAML', () => {
  const spec = loadSpec()
  assert.equal(loadSpec(), spec)
  const ops = operations()
  assert.equal(ops.length, 36)
  assert.equal(new Set(ops.map(op => op.operationId)).size, ops.length)
  for (const op of ops) {
    const source = spec.paths[op.path][op.method]
    assert.equal(op.operationId, source.operationId)
    assert.equal(op.module, source['x-opale-module'] ?? 'linux')
    assert.equal(op.raw, !!source['x-opale-raw'])
    assert.equal(op.interactive, !!source['x-opale-interactive'])
    assert.equal(op.rateLimit, source['x-opale-rate-limit'] ?? null)
  }
  assert.equal(ops.find(op => op.operationId === 'linuxGetDevice').fastifyUrl, '/api/linux/devices/:id')
  assert.equal(ops.find(op => op.operationId === 'linuxListDevices').fastifyUrl, '/api/linux/devices')
})

test('spec Linux : tous les schémas de routes JSON compilent dans Fastify', async (t) => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  for (const op of operations().filter(op => !op.raw)) {
    app.route({
      method: op.method.toUpperCase(), url: op.fastifyUrl,
      schema: schemaFor(op.operationId), handler: async () => ({}),
    })
  }
  await app.ready()
})

test('spec Linux : chaque exemple valide son schéma déréférencé en mode strict', () => {
  const ajv = new Ajv({ strict: true, allErrors: true })
  addFormats(ajv)
  for (const [name, source] of Object.entries(loadSpec().components.schemas)) {
    const schema = deref(source)
    const validate = ajv.compile(schema)
    for (const [index, example] of (source.examples ?? []).entries()) {
      assert.ok(validate(example), `${name}.examples[${index}] : ${ajv.errorsText(validate.errors)}`)
    }
  }
})

test('spec Linux : parité des operationIds enregistrés par le module', async (t) => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const registered = new Set()
  app.addHook('onRoute', route => {
    assert.ok(route.config?.operationId, `operationId manquant pour ${route.url}`)
    registered.add(route.config.operationId)
  })
  await linux.register(app)
  await app.ready()
  const spec_ids = new Set(operations().map(op => op.operationId))
  for (const id of registered) assert.ok(spec_ids.has(id), `${id} absent de la spec`)
  if (SPEC_COMPLETE) {
    for (const op of operations().filter(op => op.module === 'linux' && !op.raw)) {
      assert.ok(registered.has(op.operationId), `${op.operationId} non enregistré`)
    }
  }
})

test('spec Linux : les actions d’audit sont non vides et en snake_case', () => {
  const actions = auditActions()
  assert.ok(Array.isArray(actions) && actions.length > 0)
  for (const action of actions) assert.match(action, /^[a-z_]+$/)
})

test('deref : fusion profonde des frères, tableaux remplacés et aucune mutation du contrat', () => {
  const source = structuredClone(loadSpec().components.schemas.Error)
  const schema = deref({
    $ref: '#/components/schemas/Error',
    required: ['code'],
    properties: { error: { maxLength: 12 }, code: { const: 'TEST' } },
  })
  assert.deepEqual(schema.required, ['code'])
  assert.deepEqual(schema.properties.error, { ...source.properties.error, maxLength: 12 })
  assert.deepEqual(schema.properties.code, { ...source.properties.code, const: 'TEST' })
  assert.deepEqual(loadSpec().components.schemas.Error, source)
  schema.properties.error.type = 'integer'
  assert.equal(loadSpec().components.schemas.Error.properties.error.type, 'string')
  assert.deepEqual(deref([null, true, 1, 'texte']), [null, true, 1, 'texte'])
})

test('deref : refuse les références externes, inconnues, non schéma et cycliques', () => {
  for (const ref of ['https://example.org/schema', '#/components/responses/BadRequest', '#/components/schemas/Absent', 42]) {
    assert.throws(() => deref({ $ref: ref }), /Référence/)
  }
  const schemas = loadSpec().components.schemas
  schemas.TestCycleA = { properties: { next: { $ref: '#/components/schemas/TestCycleB' } } }
  schemas.TestCycleB = { $ref: '#/components/schemas/TestCycleA' }
  try {
    assert.throws(() => deref({ $ref: '#/components/schemas/TestCycleA' }), /cyclique/)
  } finally {
    delete schemas.TestCycleA
    delete schemas.TestCycleB
  }
})

test('schemaFor : paramètres hérités, corps, réponses référencées et réponse sans JSON', () => {
  assert.throws(() => schemaFor('absente'), /Opération inconnue/)
  const detail = schemaFor('linuxGetDevice')
  assert.deepEqual(detail.params, { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] })
  assert.deepEqual(detail.response['401'], deref(loadSpec().components.schemas.Error))
  assert.deepEqual(schemaFor('linuxAgentEnroll').body, deref(loadSpec().components.schemas.EnrollRequest))
  assert.equal(schemaFor('linuxListDevices').querystring.properties.limit.default, 100)
  assert.equal(schemaFor('linuxDeletePreregistration').response['204'], undefined)
})

test('schemaFor : remplacement des paramètres hérités et résolution des réponses chaînées', () => {
  const spec = loadSpec()
  spec.paths['/test/{id}'] = {
    parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
      { in: 'query', name: 'limit', required: true, schema: { type: 'integer', maximum: 10 } },
    ],
    get: {
      operationId: 'testOperation',
      parameters: [
        { in: 'query', name: 'limit', schema: { type: 'integer', maximum: 5 } },
        { in: 'header', name: 'X-Test', required: true, schema: { type: 'string' } },
      ],
      responses: { 400: { $ref: '#/components/responses/TestResponse' } },
    },
  }
  const responses = spec.components.responses
  responses.TestResponse = { $ref: '#/components/responses/BadRequest' }
  try {
    const schema = schemaFor('testOperation')
    assert.deepEqual(schema.querystring, { type: 'object', properties: { limit: { type: 'integer', maximum: 5 } } })
    assert.deepEqual(schema.headers, { type: 'object', properties: { 'x-test': { type: 'string' } }, required: ['x-test'] })
    assert.deepEqual(schema.response['400'], deref(spec.components.schemas.Error))
    for (const ref of ['#/components/responses/TestResponse', '#/components/responses/Absente', '#/components/schemas/Error']) {
      responses.TestResponse = { $ref: ref }
      assert.throws(() => schemaFor('testOperation'), /Référence/)
    }
    spec.paths['/test/{id}'].get.responses = undefined
    assert.equal(schemaFor('testOperation').response, undefined)
  } finally {
    delete spec.paths['/test/{id}']
    delete responses.TestResponse
  }
})
