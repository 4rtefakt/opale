// SessionBuffer accumule les frames in/out d'une session remote (SSH ou
// console-via-agent). Les caps (10 000 frames ou 5 MB) sont à la fois une
// protection RAM et une garde RGPD ("on capture max N MB par session").
// Si add() devient bavard après saturation, ou si flush() boucle, c'est
// au mieux une fuite mémoire au pire un row démesuré en DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionBuffer } from '../../modules/remote/lib/session-buffer.js'

test('SessionBuffer — état initial vide', () => {
  const b = new SessionBuffer()
  assert.equal(b.frames.length, 0)
  assert.equal(b.sizeBytes, 0)
  assert.equal(b.truncated, false)
})

test('add — frame valide est enregistrée avec ts_ms relatif + base64', () => {
  const startedAt = Date.now() - 1000 // 1 s dans le passé
  const b = new SessionBuffer({ startedAt })
  b.add('out', Buffer.from('hello'))
  assert.equal(b.frames.length, 1)
  const f = b.frames[0]
  assert.equal(f.direction, 'out')
  assert.equal(f.b64, Buffer.from('hello').toString('base64'))
  // ts_ms ≥ 1000 (au moins le delta depuis startedAt). Tolérance large
  // pour ne pas flaker sur machine lente.
  assert.ok(f.ts_ms >= 1000 && f.ts_ms < 5000, `ts_ms hors bornes: ${f.ts_ms}`)
  assert.equal(b.sizeBytes, 5)
})

test('add — ignore input non-Buffer / Buffer vide', () => {
  const b = new SessionBuffer()
  b.add('in', 'string brute')           // pas un Buffer
  b.add('in', null)
  b.add('in', undefined)
  b.add('in', Buffer.alloc(0))          // Buffer vide
  assert.equal(b.frames.length, 0)
  assert.equal(b.sizeBytes, 0)
  assert.equal(b.truncated, false, 'input invalide ne doit PAS marquer truncated')
})

test('add — sature au max frames + bascule truncated=true', () => {
  const b = new SessionBuffer({ maxFrames: 3, maxBytes: 1_000_000 })
  b.add('in', Buffer.from('a'))
  b.add('in', Buffer.from('b'))
  b.add('in', Buffer.from('c'))
  assert.equal(b.truncated, false)
  b.add('in', Buffer.from('d')) // 4e → refusée
  assert.equal(b.truncated, true)
  assert.equal(b.frames.length, 3)
  // Add suivants sont no-op silencieux.
  b.add('in', Buffer.from('e'))
  assert.equal(b.frames.length, 3)
})

test('add — sature au max bytes + bascule truncated=true', () => {
  const b = new SessionBuffer({ maxFrames: 10_000, maxBytes: 10 })
  b.add('in', Buffer.from('abcdefgh')) // 8 bytes → OK
  assert.equal(b.truncated, false)
  b.add('in', Buffer.from('ij'))       // 8+2 = 10 OK (this.sizeBytes + len > max est strict)
  assert.equal(b.truncated, false)
  b.add('in', Buffer.from('k'))        // 10 + 1 > 10 → refusée
  assert.equal(b.truncated, true)
  assert.equal(b.sizeBytes, 10)
})

test('abandon — vide le buffer sans tenter de flush', () => {
  const b = new SessionBuffer()
  b.add('in', Buffer.from('abc'))
  b.abandon()
  assert.equal(b.frames.length, 0)
  assert.equal(b.sizeBytes, 0)
})

test('flush — skip silencieusement si aucune frame capturée', async () => {
  const b = new SessionBuffer()
  let queryCalls = 0
  const fakeDb = { query: async () => { queryCalls++; return { rows: [] } } }
  await b.flush(fakeDb, 'sess-id')
  assert.equal(queryCalls, 0, 'flush sans frame ne doit PAS toucher la DB')
})

test('flush — émet un INSERT avec frames JSON + reset du buffer', async () => {
  const b = new SessionBuffer()
  b.add('out', Buffer.from('hello'))
  b.add('in',  Buffer.from('world'))

  let received = null
  const fakeDb = {
    query: async (sql, params) => {
      received = { sql, params }
      return { rows: [] }
    },
  }
  await b.flush(fakeDb, 'sess-42')

  assert.ok(received, 'flush doit appeler db.query')
  assert.match(received.sql, /INSERT INTO remote_session_logs/)
  assert.match(received.sql, /ON CONFLICT \(session_id\) DO NOTHING/)
  assert.equal(received.params[0], 'sess-42')
  // params[1] doit être un JSON parsable contenant 2 frames.
  const frames = JSON.parse(received.params[1])
  assert.equal(frames.length, 2)
  assert.equal(frames[0].direction, 'out')
  assert.equal(frames[0].b64, Buffer.from('hello').toString('base64'))
  assert.equal(received.params[2], 10)     // size_bytes (5 + 5)
  assert.equal(received.params[3], false)  // truncated

  // Reset du buffer mémoire après flush — important pour éviter qu'un
  // double appel (race browser-close + agent-disconnected) ne ré-envoie
  // les mêmes données.
  assert.equal(b.frames.length, 0)
  assert.equal(b.sizeBytes, 0)
})

test('flush — préserve truncated=true dans le row inséré', async () => {
  const b = new SessionBuffer({ maxFrames: 1 })
  b.add('out', Buffer.from('a'))
  b.add('out', Buffer.from('b')) // refusée → truncated=true

  let received = null
  await b.flush({ query: async (_, p) => { received = p; return { rows: [] } } }, 's')
  assert.equal(received[3], true, 'le flag truncated doit remonter dans le row DB')
})

test('flush — un double appel n\'envoie qu\'un seul INSERT (reset après le 1er)', async () => {
  // En pratique le ON CONFLICT DO NOTHING couvre déjà la race, mais la
  // libération mémoire dans flush() rend ce double appel safe côté Node.
  const b = new SessionBuffer()
  b.add('in', Buffer.from('x'))

  let calls = 0
  const fakeDb = { query: async () => { calls++; return { rows: [] } } }
  await b.flush(fakeDb, 's')
  await b.flush(fakeDb, 's')
  assert.equal(calls, 1, '2e flush doit être skip silencieusement')
})
