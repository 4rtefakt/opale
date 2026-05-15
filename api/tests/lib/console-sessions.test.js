// ConsoleSessionsRegistry maintient l'unicité (1 session par device) et
// pilote l'INSERT / UPDATE des rows remote_sessions + remote_session_logs.
// Tests d'intégration côté Node (DB mockée par un fake pool) — la version
// "vraie DB" arrivera en PR routes console (PR3) où on exerce le flow
// complet via fastify.inject() sur /api/console/grant.
//
// Pourquoi mocker la DB ici et pas dans PR3 : on veut tester la LOGIQUE
// du registry (conflit, idempotence close, listener disconnect) sans
// re-créer 50 tables pour 5 INSERTs. Ce qui est SQL-sensible (jsonb
// upsert ticket_messages) est vérifié sur la vraie DB ailleurs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  ConsoleSessionsRegistry,
  ConsoleConflictError,
  CONSOLE_DEFAULT_SHELL,
} from '../../modules/remote/lib/console-sessions.js'

// setup() construit un registry avec un fake pool DB qui capture toutes les
// queries pour inspection, un agentWs réel (EventEmitter), et des sockets
// neutres. Retourne aussi des helpers pour ouvrir des sessions à la volée.
function setup() {
  const queries = []
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params })
      return { rows: [], rowCount: 0 }
    },
  }
  const log = { warn: () => {}, info: () => {}, error: () => {} }
  const agentWs = new EventEmitter()
  const registry = new ConsoleSessionsRegistry({ log, db, agentWs })

  function makeAgentConn() {
    const sent = []
    return {
      sent,
      send: (type, data, sessionId) => { sent.push({ type, data, sessionId }) },
    }
  }
  function makeBrowserSocket() {
    let closed = false
    return {
      readyState: 1,
      send: () => {},
      close: (code, reason) => { closed = true; return { code, reason } },
      get closed() { return closed },
    }
  }

  return { registry, db, queries, agentWs, makeAgentConn, makeBrowserSocket }
}

const identity = { entraId: 'oid-admin-1', displayName: 'Admin Test', email: 'admin@x' }

test('findActiveByDevice — null tant qu\'aucune session', () => {
  const { registry } = setup()
  assert.equal(registry.findActiveByDevice('device-1'), null)
  assert.equal(registry.count(), 0)
})

test('create — ouvre une session, INSERT remote_sessions, retourne l\'instance', async () => {
  const { registry, queries, makeAgentConn, makeBrowserSocket } = setup()
  const sess = await registry.create({
    deviceId: 'device-1',
    agentConn: makeAgentConn(),
    browserSocket: makeBrowserSocket(),
    identity,
    shell: 'powershell.exe',
  })

  assert.ok(sess.id, 'session id généré')
  assert.equal(sess.deviceId, 'device-1')
  assert.equal(sess.shell, 'powershell.exe')
  assert.equal(registry.count(), 1)
  assert.equal(registry.findActiveByDevice('device-1'), sess)
  assert.equal(registry.get(sess.id), sess)

  // Un INSERT remote_sessions doit avoir été émis.
  const insert = queries.find(q => /INSERT INTO remote_sessions/.test(q.sql))
  assert.ok(insert, 'INSERT remote_sessions manquant')
  assert.equal(insert.params[0], sess.id)
  assert.equal(insert.params[1], 'device-1')
  assert.equal(insert.params[2], identity.entraId)
  assert.equal(insert.params[3], identity.displayName)
  assert.equal(insert.params[4], 'powershell.exe')
})

test('create — shell par défaut si omis', async () => {
  const { registry, makeAgentConn, makeBrowserSocket } = setup()
  const sess = await registry.create({
    deviceId: 'device-1',
    agentConn: makeAgentConn(),
    browserSocket: makeBrowserSocket(),
    identity,
  })
  assert.equal(sess.shell, CONSOLE_DEFAULT_SHELL)
})

test('create — 2e session sur le même device → ConsoleConflictError avec holder', async () => {
  const { registry, makeAgentConn, makeBrowserSocket } = setup()
  await registry.create({
    deviceId: 'device-1',
    agentConn: makeAgentConn(),
    browserSocket: makeBrowserSocket(),
    identity,
  })

  await assert.rejects(
    () => registry.create({
      deviceId: 'device-1',
      agentConn: makeAgentConn(),
      browserSocket: makeBrowserSocket(),
      identity: { entraId: 'oid-other', displayName: 'Autre Admin', email: 'autre@x' },
    }),
    (err) => {
      assert.ok(err instanceof ConsoleConflictError, 'doit être une ConsoleConflictError')
      assert.equal(err.code, 'CONSOLE_CONFLICT')
      // holder doit décrire qui détient déjà la session.
      assert.equal(err.holder.by_name, identity.displayName)
      assert.equal(err.holder.by_entra_id, identity.entraId)
      assert.match(err.holder.started_at, /^\d{4}-\d{2}-\d{2}T/)
      return true
    }
  )
})

test('close — envoie console.close à l\'agent + UPDATE ended_at + audit insert', async () => {
  const { registry, queries, makeAgentConn, makeBrowserSocket } = setup()
  const agentConn = makeAgentConn()
  const browserSocket = makeBrowserSocket()
  const sess = await registry.create({
    deviceId: 'device-1',
    agentConn,
    browserSocket,
    identity,
  })

  await registry.close(sess.id, 'browser-closed')

  // 1. Notif agent : send('console.close', { reason }, sessionId)
  const consoleClose = agentConn.sent.find(s => s.type === 'console.close')
  assert.ok(consoleClose, 'send console.close manquant')
  assert.equal(consoleClose.data.reason, 'browser-closed')
  assert.equal(consoleClose.sessionId, sess.id)

  // 2. Browser socket fermé.
  assert.equal(browserSocket.closed, true)

  // 3. UPDATE remote_sessions SET ended_at.
  const update = queries.find(q => /UPDATE remote_sessions/.test(q.sql))
  assert.ok(update, 'UPDATE remote_sessions manquant')
  assert.equal(update.params[0], 'browser-closed')
  assert.equal(update.params[1], sess.id)

  // 4. Audit log agent_console_close (action passée en paramètre via logAudit).
  const audit = queries.find(q => /audit_logs/.test(q.sql) && q.params?.[0] === 'agent_console_close')
  assert.ok(audit, 'INSERT audit_logs agent_console_close manquant')

  // 5. Ticket event (via attachSystemEventToOpenTicketsOfDevice).
  const tm = queries.find(q => /INSERT INTO ticket_messages/.test(q.sql))
  assert.ok(tm, 'INSERT ticket_messages (event close) manquant')

  // 6. Registry vidé.
  assert.equal(registry.count(), 0)
  assert.equal(registry.findActiveByDevice('device-1'), null)
})

test('close — idempotent (2e appel = no-op silencieux)', async () => {
  const { registry, queries, makeAgentConn, makeBrowserSocket } = setup()
  const sess = await registry.create({
    deviceId: 'device-1',
    agentConn: makeAgentConn(),
    browserSocket: makeBrowserSocket(),
    identity,
  })

  await registry.close(sess.id, 'first-close')
  const queriesAfterFirst = queries.length

  // Deuxième close — même sessionId. Ne doit ni throw ni générer de queries
  // supplémentaires (la registry ne connaît plus la session).
  await registry.close(sess.id, 'second-close')
  assert.equal(queries.length, queriesAfterFirst, 'le 2e close ne doit pas re-toucher la DB')
})

test('agentWs disconnect — ferme toutes les sessions du device', async () => {
  const { registry, agentWs, queries, makeAgentConn, makeBrowserSocket } = setup()
  const sess = await registry.create({
    deviceId: 'device-1',
    agentConn: makeAgentConn(),
    browserSocket: makeBrowserSocket(),
    identity,
  })

  // Émet l'event que pluginAgentWs déclenche en cas de WS down.
  agentWs.emit('disconnect', 'device-1')

  // _closeByDevice est fire-and-forget (close() async sans await). On laisse
  // la microtask queue se drainer avant d'asserter.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))

  assert.equal(registry.count(), 0, 'session doit avoir été fermée par disconnect')
  const update = queries.find(q => /UPDATE remote_sessions/.test(q.sql) && q.params[0] === 'agent-disconnected')
  assert.ok(update, 'la raison agent-disconnected doit apparaître dans l\'UPDATE')
  // Pas de leak du sess.id quand on requery findActiveByDevice.
  assert.equal(registry.findActiveByDevice('device-1'), null)
  // Le registry doit aussi avoir oublié le sessionId individuel.
  assert.equal(registry.get(sess.id), null)
})
