// Git smart HTTP en lecture seule (préfixe /api/linux/agent/git) : le vrai
// client `git` parle à l'API qui écoute sur un port local, protocole v0 et v2,
// clone shallow puis fetch incrémental (corps gzippé par git au-delà de 1 KiB
// grâce aux 25+ refs du miroir) ; refus 401/403/404/413/503 par injection.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { buildApp } from '../helpers/build-app.js'
import { createFleetRepo } from '../helpers/linux-fleet-repo.js'
import { seedDevice } from '../fixtures/devices.js'
import { seedLinuxDeviceKey } from '../fixtures/linux-device-keys.js'
import { createGitMirror } from '../../modules/linux/lib/git-mirror.js'
import { createGitTokenStore } from '../../modules/linux/lib/git-token-store.js'
import gitAgentRoutes from '../../modules/linux/routes/git.js'

const execFile = promisify(execFileCb)
const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip git smart HTTP'
const PREFIX = '/api/linux/agent/git'
const UPLOAD_PACK = 'application/x-git-upload-pack-request'
const REF_COUNT = 25

let db, release, repo, mirror, tokenStore, app, base, token, device, key
let tokenClock = Date.now()
const requests = []
const tags = {}

async function mint(overrides = {}) {
  return tokenStore.create({ deviceId: device.id, fingerprint: key.fingerprint, ttlMs: 600_000, ...overrides }).token
}

// Client git réel : HOME vide du dépôt de test, token dans un en-tête (jamais dans l'URL).
const gitClient = (args, { cwd = repo.root, version = 2, bearer = token } = {}) =>
  execFile('git', ['-c', `http.extraHeader=Authorization: Bearer ${bearer}`, '-c', `protocol.version=${version}`, ...args], { cwd, env: repo.env })
const revParse = (cwd, ref) => execFile('git', ['rev-parse', ref], { cwd, env: repo.env }).then(r => r.stdout.trim())

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  repo = await createFleetRepo()
  // ≥ 25 refs distinctes : la négociation du fetch dépasse 1 KiB et git gzippe son POST.
  // Des tags, pas des branches : le miroir range les branches upstream sous
  // refs/remotes/upstream/* (jamais servies à un clone), les tags sous refs/tags/*.
  await repo.commit({ message: 'initial', files: { 'README.md': 'flotte\n' } })
  for (let i = 1; i <= REF_COUNT; i++) {
    tags[`t-${i}`] = await repo.commit({ message: `ref ${i}`, files: { [`f${i}.txt`]: `${i}\n` } })
    await repo.git(['push', '-q', 'origin', `HEAD:refs/tags/t-${i}`])
  }
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.repo_url'", [repo.url])
  mirror = createGitMirror({ dir: join(repo.root, 'mirror'), home: repo.home })
  await mirror.start(db)
  assert.equal(mirror.status().state, 'ready')
  await mirror.promoteStable(mirror.heads().upstream.main)

  tokenStore = createGitTokenStore({ now: () => tokenClock })
  device = await seedDevice(db, { hostname: 'lx-git', platform: 'linux', managed_by: 'pull', ring: 'stable' })
  key = await seedLinuxDeviceKey(db, { status: 'approved', deviceId: device.id })
  token = await mint()

  app = await buildApp({
    db, registerAuth: false,
    decorators: { gitMirror: mirror, gitTokenStore: tokenStore },
    routes: async f => {
      f.addHook('onRequest', async req => {
        requests.push({ url: req.url, encoding: req.headers['content-encoding'] ?? null, protocol: req.headers['git-protocol'] ?? null })
      })
      await f.register(gitAgentRoutes, { prefix: PREFIX })
      // Le parser du corps git reste dans le scope du plugin.
      f.post('/_outside', async req => ({ type: typeof req.body }))
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}${PREFIX}/fleet.git`
})

after(async () => {
  if (app) await app.close()
  mirror?.stop()
  tokenStore?.stop()
  if (release) await release()
  await closeSharedPool()
  await repo?.cleanup()
})

function inject({ method = 'GET', url, headers = {}, payload } = {}) {
  return app.inject({ method, url: PREFIX + url, headers: { authorization: `Bearer ${token}`, ...headers }, payload })
}

const uploadPack = (headers = {}, payload = '0000') => inject({
  method: 'POST', url: '/fleet.git/git-upload-pack', headers: { 'content-type': UPLOAD_PACK, ...headers }, payload,
})

async function cloneAndFetch(version) {
  requests.length = 0
  const clone = join(repo.root, `clone-v${version}`)
  const stable = mirror.heads().stable
  // --no-single-branch : le clone ramène aussi les tags (négociation > 1 KiB → gzip).
  await gitClient(['clone', '-q', '--depth', '1', '--no-single-branch', '-b', 'stable', `${base}`, clone], { version })
  assert.equal(await revParse(clone, 'HEAD'), stable)
  assert.equal(await revParse(clone, 'refs/tags/t-1'), tags['t-1'])
  assert.equal(await revParse(clone, `refs/tags/t-${REF_COUNT}`), tags[`t-${REF_COUNT}`])
  const advertised = requests.find(r => r.url.endsWith('/info/refs?service=git-upload-pack'))
  assert.ok(advertised, 'info/refs servi')
  assert.equal(advertised.protocol, version === 2 ? 'version=2' : null)
  assert.ok(requests.some(r => r.url.endsWith('/git-upload-pack') && r.encoding === 'gzip'), 'un POST gzippé a été inflaté par http-backend')

  // Fetch à vide, puis incrémental après un nouveau commit + fetch du miroir + promotion.
  requests.length = 0
  await gitClient(['fetch', '-q', 'origin'], { cwd: clone, version })
  assert.equal(await revParse(clone, 'refs/remotes/origin/stable'), stable)
  const next = await repo.commit({ message: `après clone v${version}` })
  await mirror.fetch()
  await mirror.promoteStable(next)
  await gitClient(['fetch', '-q', 'origin'], { cwd: clone, version })
  assert.equal(await revParse(clone, 'refs/remotes/origin/stable'), next)
  // Sans signataire configuré, pilot suit la tête de main ; main lui-même n'est jamais servi.
  assert.equal(await revParse(clone, 'refs/remotes/origin/pilot'), next)
  await assert.rejects(revParse(clone, 'refs/remotes/origin/main'))
  assert.equal(mirror.status().children, 0, 'tous les enfants http-backend sont terminés')
}

test('clone shallow de stable puis fetch incrémental — protocole v2', { skip: SKIP }, async () => {
  await cloneAndFetch(2)
})

test('clone shallow de stable puis fetch incrémental — protocole v0', { skip: SKIP }, async () => {
  await cloneAndFetch(0)
})

test('info/refs : seul git-upload-pack est servi', { skip: SKIP }, async () => {
  for (const query of ['?service=git-receive-pack', '', '?service=']) {
    const res = await inject({ url: '/fleet.git/info/refs' + query })
    assert.equal(res.statusCode, 403, res.body)
    assert.equal(res.json().code, 'SERVICE_FORBIDDEN')
  }
})

test('receive-pack, HEAD et objets du protocole dumb : jamais routés (404)', { skip: SKIP }, async () => {
  const cases = [
    ['POST', '/fleet.git/git-receive-pack', { 'content-type': 'application/x-git-receive-pack-request' }, '0000'],
    ['GET', '/fleet.git/HEAD'], ['GET', '/fleet.git/objects/info/packs'], ['GET', '/fleet.git/info/refs/../HEAD'],
  ]
  for (const [method, url, headers, payload] of cases) {
    const res = await inject({ method, url, headers, payload })
    assert.equal(res.statusCode, 404, `${method} ${url}: ${res.body}`)
  }
})

test('token absent, mal formé, inconnu ou expiré → 401', { skip: SKIP }, async () => {
  const url = '/fleet.git/info/refs?service=git-upload-pack'
  for (const authorization of [undefined, 'Basic abc', 'Bearer ' + 'gt_' + 'f'.repeat(40), 'Bearer pas-un-token', `Bearer ${token}x`]) {
    const res = await app.inject({ url: PREFIX + url, headers: authorization ? { authorization } : {} })
    assert.equal(res.statusCode, 401, res.body)
    assert.equal(res.json().code, 'TOKEN_INVALID')
  }
  const short = await mint({ ttlMs: 1000 })
  assert.equal((await inject({ url, headers: { authorization: `Bearer ${short}` } })).statusCode, 200)
  tokenClock += 1000
  const expired = await inject({ url, headers: { authorization: `Bearer ${short}` } })
  assert.equal(expired.statusCode, 401)
  assert.equal(expired.json().code, 'TOKEN_EXPIRED')
  assert.equal((await inject({ url, headers: { authorization: `Bearer ${short}` } })).json().code, 'TOKEN_INVALID')
})

test('clé révoquée après émission du token → 401 REVOKED immédiat', { skip: SKIP }, async () => {
  const other = await seedDevice(db, { hostname: 'lx-revoked', platform: 'linux', managed_by: 'pull', ring: 'stable' })
  const otherKey = await seedLinuxDeviceKey(db, { status: 'approved', deviceId: other.id })
  const otherToken = tokenStore.create({ deviceId: other.id, fingerprint: otherKey.fingerprint, ttlMs: 600_000 }).token
  const url = '/fleet.git/info/refs?service=git-upload-pack'
  assert.equal((await inject({ url, headers: { authorization: `Bearer ${otherToken}` } })).statusCode, 200)
  await db.query("UPDATE linux_device_keys SET status = 'revoked', revoked_at = now() WHERE id = $1", [otherKey.id])
  const res = await inject({ url, headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(res.statusCode, 401, res.body)
  assert.equal(res.json().code, 'REVOKED')
  const pack = await uploadPack({ authorization: `Bearer ${otherToken}` })
  assert.equal(pack.statusCode, 401)
})

test('miroir pas prêt → 503 + Retry-After', { skip: SKIP }, async () => {
  const absent = createGitMirror({ dir: join(repo.root, 'absent'), home: repo.home })
  const other = await buildApp({
    db, registerAuth: false,
    decorators: { gitMirror: absent, gitTokenStore: tokenStore },
    routes: f => f.register(gitAgentRoutes, { prefix: PREFIX }),
  })
  try {
    const res = await other.inject({ url: `${PREFIX}/fleet.git/info/refs?service=git-upload-pack`, headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.headers['retry-after'], '30')
    assert.equal(res.json().code, 'MIRROR_NOT_READY')
  } finally {
    await other.close()
  }
})

test('sémaphore : au-delà de 8 enfants simultanés → 503 + Retry-After, puis service rétabli', { skip: SKIP }, async () => {
  const slots = []
  for (let i = 0; i < 8; i++) slots.push(mirror.acquireHttpSlot())
  assert.ok(slots.every(Boolean))
  assert.equal(mirror.acquireHttpSlot(), null)
  try {
    const res = await inject({ url: '/fleet.git/info/refs?service=git-upload-pack' })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.headers['retry-after'], '30')
    assert.equal(res.json().code, 'BUSY')
    assert.equal(mirror.status().children, 8)
  } finally {
    for (const free of slots) free()
  }
  assert.equal(mirror.status().children, 0)
  assert.equal((await inject({ url: '/fleet.git/info/refs?service=git-upload-pack' })).statusCode, 200)
})

test('corps de plus de 4 MiB → 413, enfant tué, slot rendu', { skip: SKIP }, async () => {
  const url = new URL(`${base}/git-upload-pack`)
  const chunk = Buffer.alloc(64 * 1024, 0x30)
  const total = 4 * 1024 * 1024 + chunk.length
  const status = await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': UPLOAD_PACK, 'content-length': String(total) },
    })
    req.once('response', res => { res.resume(); resolve(res.statusCode) })
    // Le serveur peut couper la socket après le 413 avant la fin de l'envoi : seule la réponse compte.
    req.once('error', err => { if (!req.res) reject(err) })
    let sent = 0
    const write = () => {
      while (sent < total) {
        sent += chunk.length
        if (!req.write(chunk)) return req.once('drain', write)
      }
      req.end()
    }
    write()
  })
  assert.equal(status, 413)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(mirror.status().children, 0)
  assert.equal((await uploadPack()).statusCode, 200, 'le service continue après un 413')
})

test('upload-pack sans content-type git (JSON, texte, corps absent) → 415, aucun enfant lancé', { skip: SKIP }, async () => {
  const cases = [
    [{ 'content-type': 'application/json' }, JSON.stringify({ a: 1 })],
    [{ 'content-type': 'text/plain' }, '0000'],
    [{}, undefined],
  ]
  for (const [headers, payload] of cases) {
    const res = await inject({ method: 'POST', url: '/fleet.git/git-upload-pack', headers, payload })
    assert.equal(res.statusCode, 415, res.body)
    assert.equal(res.json().code, 'UNSUPPORTED_MEDIA_TYPE')
  }
  assert.equal(mirror.status().children, 0)
})

test('le parser du corps git est encapsulé dans le plugin', { skip: SKIP }, async () => {
  const res = await app.inject({ method: 'POST', url: '/_outside', headers: { 'content-type': UPLOAD_PACK }, payload: '0000' })
  assert.equal(res.statusCode, 415, res.body)
})
