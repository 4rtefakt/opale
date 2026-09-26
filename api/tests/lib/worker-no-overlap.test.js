// Workers périodiques : un tick ne démarre pas tant que le précédent n'est
// pas terminé, et l'arrêt attend le tick en cours.
//
// On démarre chaque worker avec un intervalle très court et une « base »
// dont la première requête ne répond pas (Graph / Postgres lent) : sans
// garde, chaque tick de setInterval relançait un traitement complet en
// parallèle du précédent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { nonOverlapping } from '../../lib/non-overlapping.js'
import { startMailPollWorker, stopMailPollWorker } from '../../modules/email-bridge/lib/poll-worker.js'
import { startMailSentPollWorker, stopMailSentPollWorker } from '../../modules/email-bridge/lib/sent-poll-worker.js'
import { startMailOutboundWorker, stopMailOutboundWorker } from '../../modules/email-bridge/lib/outbound-worker.js'
import { startMailMarkReadWorker, stopMailMarkReadWorker } from '../../modules/email-bridge/lib/mark-read-worker.js'
import { startGroupSyncWorker, stopGroupSyncWorker } from '../../modules/groups/lib/group-sync.js'

// Base dont les requêtes restent en attente jusqu'à release().
function hangingDb() {
  const pending = []
  return {
    calls: 0,
    query() {
      this.calls++
      return new Promise((resolve) => pending.push(resolve))
    },
    release() { for (const r of pending.splice(0)) r({ rows: [] }) },
  }
}

const WORKERS = [
  ['poll-worker (boîtes de réception)', startMailPollWorker, stopMailPollWorker],
  ['sent-poll-worker (éléments envoyés)', startMailSentPollWorker, stopMailSentPollWorker],
  ['outbound-worker (envoi des réponses)', startMailOutboundWorker, stopMailOutboundWorker],
  ['mark-read-worker (marquage lu)', startMailMarkReadWorker, stopMailMarkReadWorker],
  ['group-sync (groupes Entra)', startGroupSyncWorker, stopGroupSyncWorker],
]

for (const [name, start, stop] of WORKERS) {
  test(`${name} : pas de tick concurrent tant que le précédent n'est pas fini, arrêt propre`, async () => {
    const db = hangingDb()
    start(db, null, 5)
    await sleep(80)   // ~15 intervalles
    const calls = db.calls
    let stopped = false
    const stopping = Promise.resolve(stop()).then(() => { stopped = true })
    db.release()
    await stopping
    assert.equal(calls, 1, 'un seul tick en cours : les suivants sont sautés')
    assert.ok(stopped)
    // Plus aucun tick après l'arrêt (timer d'intervalle ET timer initial).
    const after = db.calls
    await sleep(40)
    assert.equal(db.calls, after)
  })
}

test('stop() attend la fin du tick en cours', async () => {
  const db = hangingDb()
  startGroupSyncWorker(db, null, 5)   // premier tick immédiat, bloqué sur la base
  await sleep(10)
  let stopped = false
  const stopping = Promise.resolve(stopGroupSyncWorker()).then(() => { stopped = true })
  await sleep(20)
  assert.equal(stopped, false, 'le tick en cours n’est pas terminé')
  db.release()
  await stopping
  assert.equal(stopped, true)
})

test('nonOverlapping : saute les appels pendant un tick, reprend ensuite, erreurs contenues', async () => {
  let calls = 0
  let finish
  const errors = []
  const run = nonOverlapping(async () => {
    calls++
    if (calls === 2) throw new Error('boom')
    await new Promise((r) => { finish = r })
  }, { onError: (err) => errors.push(err.message) })

  run(); run(); run()
  await sleep(5)
  assert.equal(calls, 1)
  finish()
  await run.idle()

  await run()                       // 2e appel : lève → onError, pas de rejection
  assert.deepEqual(errors, ['boom'])
  assert.equal(calls, 2)

  const third = run()               // de nouveau disponible après une erreur
  await sleep(5)
  assert.equal(calls, 3)
  finish()
  await third
  await run.idle()
})
