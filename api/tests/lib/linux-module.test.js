import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import linux, { SPEC_COMPLETE } from '../../modules/linux/index.js'
import { modulesConfig } from '../../modules.config.js'
import { operations } from '../../modules/linux/lib/spec.js'

test('module Linux : contrat du chargeur, désactivé par défaut et enregistrable sans DB', async (t) => {
  assert.equal(linux.name, 'linux')
  assert.deepEqual(linux.requires, ['core', 'inventory'])
  assert.equal(modulesConfig.linux, false)
  assert.equal(SPEC_COMPLETE, false)
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  // Décorateurs fournis par core (plugins/auth.js) et le plugin db en prod.
  app.decorate('db', null)
  for (const name of ['authenticate', 'requireAdmin', 'requireInteractive']) app.decorate(name, async () => {})
  app.decorate('getUserIdentity', () => null)
  const messages = []
  app.log.info = message => messages.push(message)
  const routes = []
  app.addHook('onRoute', route => routes.push(`${route.method} ${route.url}`))
  await linux.register(app)
  await app.ready()
  assert.deepEqual(messages, [`[linux] Module chargé, enrôlement et miroir git actifs (${operations().length} opérations dans la spec)`])
  assert.ok(routes.includes('POST /api/linux/agent/enroll'))
  assert.ok(routes.includes('POST /api/linux/enrollments/:id/approve'))
  assert.ok(routes.includes('DELETE /api/linux/preregistrations/:id'))
  assert.ok(routes.includes('POST /api/linux/devices/:id/revoke'))
  assert.ok(routes.includes('GET /api/linux/agent/git/fleet.git/info/refs'))
  assert.ok(routes.includes('POST /api/linux/rings/stable/promote'))
  // Le parser JSON brut reste dans le scope agent.
  assert.equal(app.hasDecorator('deviceAuth'), false)
  assert.equal(typeof app.gitMirror.status, 'function')
  assert.equal(typeof app.gitTokenStore.create, 'function')
  assert.equal(app.gitMirror.status().state, 'absent')
  await linux.stopWorkers(app)
})
