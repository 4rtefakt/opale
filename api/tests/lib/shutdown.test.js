// Arrêt propre (lib/shutdown.js + stopModuleWorkers) : SIGTERM ferme
// Fastify puis sort en 0, délai borné, second signal = sortie immédiate, et
// le tick en cours d'un worker se termine AVANT la fermeture du pool.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'

import { installShutdownHandlers } from '../../lib/shutdown.js'
import { stopModuleWorkers, stopWorkersBeforeClose } from '../../lib/module-loader.js'
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
  stopWorkersBeforeClose(app, modules)
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

test('SIGTERM avec une requête keep-alive en vol : workers arrêtés, sortie propre sans attendre keepAliveTimeout', { timeout: 10000 }, async (t) => {
  // Caddy garde ses connexions amont ouvertes : une connexion dont la
  // requête est en cours au signal reste ouverte après la réponse, et
  // server.close() l'attendait jusqu'à keepAliveTimeout (72 s) → sortie
  // forcée en code 1, hooks onClose (arrêt des workers) jamais exécutés.
  const app = Fastify({ logger: false })
  app.get('/slow', async () => { await sleep(300); return { ok: true } })
  let workersStoppedAt = null
  const t0 = Date.now()
  stopWorkersBeforeClose(app, { fake: { name: 'fake', stopWorkers: async () => { workersStoppedAt = Date.now() - t0 } } })
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => app.close().catch(() => {}))

  const proc = new EventEmitter()
  const exits = []
  installShutdownHandlers(app, { proc, exit: (c) => exits.push(c), timeoutMs: 4000 })

  const agent = new http.Agent({ keepAlive: true })
  t.after(() => agent.destroy())
  const response = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/slow', agent }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }).on('error', reject)
  })
  await sleep(50)
  proc.emit('SIGTERM', 'SIGTERM')

  assert.equal(await response, 200, 'la requête en cours se termine normalement')
  while (!exits.length && Date.now() - t0 < 6000) await sleep(20)
  assert.deepEqual(exits, [0], 'fermeture terminée avant le délai de sortie forcée')
  assert.ok(Date.now() - t0 < 2000, `fermeture en ${Date.now() - t0} ms`)
  assert.ok(workersStoppedAt !== null && workersStoppedAt < 300, `workers arrêtés dès le signal (${workersStoppedAt} ms)`)
})
