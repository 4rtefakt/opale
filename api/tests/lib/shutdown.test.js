// Arrêt propre (lib/shutdown.js + stopModuleWorkers) : SIGTERM ferme
// Fastify puis sort en 0, délai borné, second signal = sortie immédiate, et
// le tick en cours d'un worker se termine AVANT la fermeture du pool.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'

import { installShutdownHandlers } from '../../lib/shutdown.js'
import { stopModuleWorkers } from '../../lib/module-loader.js'
import { nonOverlapping } from '../../lib/non-overlapping.js'
import dbPlugin from '../../plugins/db.js'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'
const silentLog = { info() {}, warn() {}, error() {} }

after(closeSharedPool)

function harness(close, opts = {}) {
  const proc = new EventEmitter()
  const exits = []
  const fastify = { log: silentLog, close }
  installShutdownHandlers(fastify, { proc, exit: (c) => exits.push(c), ...opts })
  return { proc, exits }
}

test('SIGTERM et SIGINT : fastify.close() puis exit(0)', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    let closed = 0
    const { proc, exits } = harness(async () => { closed++ })
    proc.emit(signal, signal)
    await sleep(10)
    assert.equal(closed, 1, signal)
    assert.deepEqual(exits, [0], signal)
  }
})

test('fermeture bloquée : sortie forcée en code 1 après le délai', async () => {
  const { proc, exits } = harness(() => new Promise(() => {}), { timeoutMs: 50 })
  proc.emit('SIGTERM', 'SIGTERM')
  await sleep(20)
  assert.deepEqual(exits, [])
  await sleep(60)
  assert.deepEqual(exits, [1])
})

test('fermeture en erreur : exit(1)', async () => {
  const { proc, exits } = harness(async () => { throw new Error('boom') })
  proc.emit('SIGTERM', 'SIGTERM')
  await sleep(10)
  assert.deepEqual(exits, [1])
})

test('second signal pendant la fermeture : sortie immédiate en code 1', async () => {
  let closed = 0
  const { proc, exits } = harness(async () => { closed++; await sleep(50) })
  proc.emit('SIGTERM', 'SIGTERM')
  proc.emit('SIGINT', 'SIGINT')
  assert.deepEqual(exits, [1])
  assert.equal(closed, 1, 'close() appelé une seule fois')
  await sleep(80)
})

test('stopModuleWorkers : appelle chaque stopWorkers, un échec n’empêche pas les autres', async () => {
  const stopped = []
  const modules = {
    a: { name: 'a', stopWorkers: async () => { await sleep(5); stopped.push('a') } },
    b: { name: 'b', stopWorkers: async () => { throw new Error('boom') } },
    c: { name: 'c' },
    d: { name: 'd', stopWorkers: async () => { stopped.push('d') } },
  }
  await stopModuleWorkers(modules, { log: silentLog })
  assert.deepEqual(stopped.sort(), ['a', 'd'])
})

test('SIGTERM pendant un tick de worker : le tick se termine avant la fermeture du pool', { skip: SKIP }, async (t) => {
  const { connection, release } = await acquireSchema({ migrate: false })
  t.after(release)

  // Même câblage qu'index.js : plugin db, puis hook onClose d'arrêt des workers.
  const app = Fastify({ logger: false })
  await app.register(dbPlugin, { env: { DB_AUTO_MIGRATE: 'false' }, connection })
  let tickDone = false
  let tickError = null
  const run = nonOverlapping(async () => {
    await app.db.query('SELECT pg_sleep(0.2)')
    await app.db.query('SELECT 1')   // après le signal : le pool doit être encore ouvert
    tickDone = true
  }, { onError: (err) => { tickError = err } })
  const modules = { fake: { name: 'fake', stopWorkers: () => run.idle() } }
  app.addHook('onClose', () => stopModuleWorkers(modules, app))
  await app.ready()

  const proc = new EventEmitter()
  const exits = []
  installShutdownHandlers(app, { proc, exit: (c) => exits.push(c) })
  run()
  await sleep(50)                   // tick en cours (pg_sleep)
  proc.emit('SIGTERM', 'SIGTERM')
  while (!exits.length) await sleep(10)

  assert.equal(tickError, null)
  assert.equal(tickDone, true)
  assert.deepEqual(exits, [0])
})
