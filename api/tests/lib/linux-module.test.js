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
  const messages = []
  app.log.info = message => messages.push(message)
  await linux.register(app)
  await app.ready()
  assert.deepEqual(messages, [`[linux] Module chargé, ${operations().length} opérations de la spec en attente`])
})
