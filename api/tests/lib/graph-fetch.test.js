// Appels Graph : timeout et reprise bornée sur 429 (Retry-After).
//
// 1) graphFetch contre un vrai serveur HTTP local (fetch réel) ;
// 2) les fonctions Graph existantes (core/lib/graph.js, email-bridge) avec
//    globalThis.fetch / fetchImpl remplacés : elles doivent survivre à une
//    429 et ne plus rester bloquées sur un Graph muet.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { graphFetch, graphFetchDefaults, retryAfterMs, GRAPH_RETRY_ABORTED } from '../../modules/core/lib/graph-fetch.js'
import { getAllAADUsers, getUserPhoto, getGroupDeviceHostnames } from '../../modules/core/lib/graph.js'
import { sendMail } from '../../modules/email-bridge/lib/graph-send.js'
import { markMessageAsRead } from '../../modules/email-bridge/lib/graph-mail.js'

// ── Serveur local scriptable ─────────────────────────────────────────────────

let server, base
const hits = []
let handler = (req, res) => res.end('{}')

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { hits.push({ method: req.method, url: req.url, body }); handler(req, res, hits.length) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => { server.closeAllConnections?.(); server.close() })

function reset(h) { hits.length = 0; handler = h }
const noSleep = { sleep: async () => {} }

test('Graph muet : abandon après le timeout', async () => {
  reset(() => { /* ne répond jamais */ })
  const t0 = Date.now()
  await assert.rejects(graphFetch(`${base}/v1.0/users`, {}, { timeoutMs: 100 }), /pas de réponse en 100 ms/)
  assert.ok(Date.now() - t0 < 1000)
})

test('429 + Retry-After : attend le délai demandé puis réessaie (même corps pour un POST)', async () => {
  reset((req, res, n) => {
    if (n === 1) { res.writeHead(429, { 'Retry-After': '2' }); return res.end('{"error":"throttled"}') }
    res.writeHead(202); res.end()
  })
  const waits = []
  const res = await graphFetch(`${base}/v1.0/users/x/sendMail`,
    { method: 'POST', body: '{"message":1}', headers: { 'Content-Type': 'application/json' } },
    { sleep: async (ms) => { waits.push(ms) } })
  assert.equal(res.status, 202)
  assert.deepEqual(waits, [2000])
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map(h => h.body), ['{"message":1}', '{"message":1}'])
})

test('429 persistante : au plus 3 reprises, la dernière 429 est rendue', async () => {
  reset((req, res) => { res.writeHead(429, { 'Retry-After': '0' }); res.end() })
  const res = await graphFetch(`${base}/v1.0/users`, {}, noSleep)
  assert.equal(res.status, 429)
  assert.equal(hits.length, 4)
})

test('Retry-After trop long : pas d’attente, la 429 est rendue', async () => {
  reset((req, res) => { res.writeHead(429, { 'Retry-After': '3600' }); res.end() })
  const waits = []
  const res = await graphFetch(`${base}/v1.0/users`, {}, { sleep: async (ms) => { waits.push(ms) } })
  assert.equal(res.status, 429)
  assert.equal(hits.length, 1)
  assert.deepEqual(waits, [])
})

test('503 : pas de reprise (un POST aurait pu être traité)', async () => {
  reset((req, res) => { res.writeHead(503, { 'Retry-After': '0' }); res.end() })
  const res = await graphFetch(`${base}/v1.0/users/x/sendMail`, { method: 'POST', body: '{}' }, noSleep)
  assert.equal(res.status, 503)
  assert.equal(hits.length, 1)
})

test('arrêt pendant l’attente d’une 429 (stopSignal) : attente interrompue, pas de nouvelle requête', { timeout: 4000 }, async () => {
  reset((req, res) => { res.writeHead(429, { 'Retry-After': '5' }); res.end() })
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 50)
  const t0 = Date.now()
  await assert.rejects(
    graphFetch(`${base}/v1.0/users/x/sendMail`, { method: 'POST', body: '{}' }, { stopSignal: stop.signal }),
    (err) => err.code === GRAPH_RETRY_ABORTED)
  assert.ok(Date.now() - t0 < 1000, 'attente de Retry-After interrompue')
  assert.equal(hits.length, 1, 'la requête refusée (429) n’est pas rejouée')
})

test('retryAfterMs : secondes, date HTTP, défaut exponentiel', () => {
  assert.equal(retryAfterMs('5', 0), 5000)
  const now = Date.parse('2026-09-26T10:00:00Z')
  assert.equal(retryAfterMs('Sat, 26 Sep 2026 10:00:07 GMT', 0, now), 7000)
  assert.equal(retryAfterMs(null, 0), 1000)
  assert.equal(retryAfterMs('n/a', 2), 4000)
})

// ── Fonctions Graph existantes ───────────────────────────────────────────────

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

function stubGlobalFetch(t, route) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/oauth2/v2.0/token')) return jsonRes(200, { access_token: 'fake', expires_in: 3600 })
    return route(u, init, calls)
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

test('getAllAADUsers : une 429 de Graph est rejouée au lieu d’échouer', async (t) => {
  let n = 0
  stubGlobalFetch(t, () => (++n === 1
    ? jsonRes(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '0' })
    : jsonRes(200, { value: [{ id: 'u1' }] })))
  const users = await getAllAADUsers(null)
  assert.deepEqual(users, [{ id: 'u1' }])
})

test('getGroupDeviceHostnames : chaque appel Graph porte un signal de timeout', async (t) => {
  const calls = stubGlobalFetch(t, () => jsonRes(200, { value: [{ displayName: 'PC-1' }] }))
  await getGroupDeviceHostnames('00000000-0000-0000-0000-000000000001')
  assert.ok(calls.length >= 1)
  for (const c of calls) assert.ok(c.init.signal instanceof AbortSignal, c.url)
})

test('getUserPhoto : Graph muet → erreur après le timeout (plus de blocage)', { timeout: 3000 }, async (t) => {
  const saved = graphFetchDefaults.timeoutMs
  graphFetchDefaults.timeoutMs = 100
  t.after(() => { graphFetchDefaults.timeoutMs = saved })
  stubGlobalFetch(t, (url, init) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason))
  }))
  await assert.rejects(getUserPhoto('00000000-0000-0000-0000-000000000002'), /pas de réponse en 100 ms/)
})

test('sendMail : 429 puis 202 → un seul mail envoyé, pas d’erreur', async (t) => {
  stubGlobalFetch(t, () => { throw new Error('ne doit pas passer par globalThis.fetch') })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return calls.length === 1 ? jsonRes(429, {}, { 'Retry-After': '0' }) : jsonRes(202, null)
  }
  const out = await sendMail({ sender: 'helpdesk@example.com', to: 'a@example.com', subject: 's', bodyText: 'b', fetchImpl })
  assert.equal(out.status, 202)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(c => c.init.signal instanceof AbortSignal))
})

test('markMessageAsRead : signal de timeout transmis', async (t) => {
  stubGlobalFetch(t, () => { throw new Error('ne doit pas passer par globalThis.fetch') })
  let seen
  await markMessageAsRead('box@example.com', 'AAMk', {
    fetchImpl: async (url, init) => { seen = init; return jsonRes(200, {}) },
  })
  assert.ok(seen.signal instanceof AbortSignal)
})
