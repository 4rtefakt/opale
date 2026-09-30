import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import linux, { SPEC_COMPLETE } from '../../modules/linux/index.js'
import { loadSpec, deref, schemaFor, operations, auditActions } from '../../modules/linux/lib/spec.js'

// Décorateurs attendus par les routes admin (plugins/auth.js) et par les
// handlers, sans base ni JWT : seul l'enregistrement est exercé ici.
function bareApp() {
  const app = Fastify({ logger: false })
  app.decorate('db', null)
  for (const name of ['authenticate', 'requireAdmin', 'requireInteractive']) app.decorate(name, async () => {})
  app.decorate('getUserIdentity', () => null)
  return app
}

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
  const app = bareApp()
  t.after(() => app.close())
  const registered = new Map()
  app.addHook('onRoute', route => {
    if (route.method === 'HEAD') return // jumeau HEAD ajouté par Fastify à chaque GET
    assert.ok(route.config?.operationId, `operationId manquant pour ${route.url}`)
    registered.set(route.config.operationId, route)
  })
  await linux.register(app)
  await app.ready()
  const byId = new Map(operations().map(op => [op.operationId, op]))
  for (const [id, route] of registered) {
    const op = byId.get(id)
    assert.ok(op, `${id} absent de la spec`)
    assert.equal(route.url, op.fastifyUrl, `${id} : URL différente de la spec`)
    assert.equal(route.method, op.method.toUpperCase(), `${id} : méthode différente de la spec`)
  }
  // PR 2a : enrôlement, file d'attente, pré-inscriptions, révocation.
  for (const id of ['linuxAgentEnroll', 'linuxListEnrollments', 'linuxCountEnrollments', 'linuxApproveEnrollment',
    'linuxApproveBulk', 'linuxRejectEnrollment', 'linuxRejectBulk', 'linuxListPreregistrations',
    'linuxCreatePreregistrations', 'linuxPreregisterFromDevices', 'linuxDeletePreregistration', 'linuxRevokeDevice',
    // PR 4a : check-in, vues des postes, affectation, état de l'escrow.
    'linuxAgentCheckin', 'linuxListDevices', 'linuxGetDevice', 'linuxUpdateDevice', 'linuxAssignBulk', 'linuxEscrowStatus']) {
    assert.ok(registered.has(id), `${id} non enregistré`)
  }
  if (SPEC_COMPLETE) {
    for (const op of operations().filter(op => op.module === 'linux' && !op.raw)) {
      assert.ok(registered.has(op.operationId), `${op.operationId} non enregistré`)
    }
  }
})

test('spec Linux : les routes interactives portent requireInteractive, les autres non', async (t) => {
  const app = bareApp()
  t.after(() => app.close())
  const interactive = async () => {}
  app.requireInteractive = interactive
  const routes = []
  app.addHook('onRoute', route => { if (route.method !== 'HEAD') routes.push(route) })
  await linux.register(app)
  await app.ready()
  const byId = new Map(operations().map(op => [op.operationId, op]))
  for (const route of routes) {
    const op = byId.get(route.config.operationId)
    const handlers = [].concat(route.preHandler ?? [])
    assert.equal(handlers.includes(interactive), op.interactive, `${op.operationId} : garde interactive ${op.interactive ? 'attendue' : 'inattendue'}`)
    if (op.module === 'linux' && !route.url.startsWith('/api/linux/agent/')) {
      assert.equal(handlers.length >= 2, true, `${op.operationId} : authenticate + requireAdmin attendus`)
    }
  }
})

test('spec Linux : les actions d’audit sont non vides et en snake_case', () => {
  const actions = auditActions()
  assert.ok(Array.isArray(actions) && actions.length > 0)
  for (const action of actions) assert.match(action, /^[a-z_]+$/)
})

// Évite la dérive du vocabulaire : chaque littéral `action: '…'` du module,
// et tout littéral `'linux_…'` hors noms de tables, doit être déclaré dans
// info.x-opale-audit-actions.
test('spec Linux : chaque action d’audit du code source est déclarée dans la spec', () => {
  const root = new URL('../../modules/linux/', import.meta.url).pathname
  const files = readdirSync(root, { recursive: true }).filter(f => f.endsWith('.js')).map(f => join(root, f))
  assert.ok(files.length >= 10, 'sources du module trouvées')
  const tables = new Set(['linux_device_keys', 'linux_preregistrations', 'linux_apply_reports'])
  const declared = new Set(auditActions())
  const found = new Set()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const literals = [...source.matchAll(/action:\s*'([a-z_]+)'/g), ...source.matchAll(/'(linux_[a-z_]+)'/g)]
    for (const [, action] of literals) {
      if (tables.has(action)) continue
      assert.ok(declared.has(action), `${action} (${file}) absent de x-opale-audit-actions`)
      found.add(action)
    }
  }
  for (const action of ['linux_device_enrolled', 'linux_enroll_serial_conflict', 'linux_enroll_flood', 'linux_key_serial_mismatch',
    'linux_device_approved', 'linux_device_converted', 'linux_device_reenrolled', 'linux_device_rejected', 'linux_device_revoked',
    'linux_preregistrations_imported']) {
    assert.ok(found.has(action), `${action} attendu dans le code de la PR 2a`)
  }
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
