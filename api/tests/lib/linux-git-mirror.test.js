// Miroir git du dépôt de flotte : cycle de vie, branches de ring, promotion,
// journal, profils, échéances. Vrai `git` local, aucun réseau.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createFleetRepo } from '../helpers/linux-fleet-repo.js'
import { createGitMirror } from '../../modules/linux/lib/git-mirror.js'

const execFile = promisify(execFileCb)
const T0 = Date.parse('2026-09-30T10:00:00Z')
let clock = T0
let repo, dir, mirror, settings

// Base factice : uniquement les lignes de settings lues par le miroir.
const fakeDb = (overrides = {}) => ({
  async query() {
    return { rows: Object.entries({ ...settings, ...overrides }).map(([key, value]) => ({ key, value })) }
  },
})

const build = (options = {}) => createGitMirror({ dir, home: repo.home, now: () => clock, ...options })
// Miroir isolé, démarré sans upstream (auto-contrôle des binaires fait, état absent).
async function detached(options) {
  const instance = build(options)
  await instance.start(fakeDb({ 'linux.repo_url': '' }))
  assert.equal(instance.status().state, 'absent')
  return instance
}

before(async () => {
  repo = await createFleetRepo()
  dir = join(repo.root, 'mirror')
  settings = {
    'linux.repo_url': repo.url, 'linux.allowed_signers': '[]', 'linux.alerts_enabled': 'false',
    'linux.ring.pilot': '{"branch":"main"}', 'linux.ring.stable': '{"branch":"main"}',
  }
})

after(async () => {
  mirror?.stop()
  await repo?.cleanup()
})

test('absent → cloning → ready : layout, config du miroir, refs de ring et têtes en cache', async () => {
  const first = await repo.commit({ message: 'initial', files: { 'README.md': 'flotte\n' } })
  mirror = build()
  assert.equal(mirror.status().state, 'absent')
  assert.equal(mirror.serving(), false)
  await mirror.start(fakeDb())
  const status = mirror.status()
  assert.equal(status.state, 'ready')
  assert.equal(mirror.serving(), true)
  assert.equal(status.binaries_ok, true)
  assert.equal(status.upstream, repo.url)
  assert.equal(status.last_fetch_at, new Date(T0).toISOString())
  assert.equal(status.fetch_age_s, 0)
  assert.equal(status.last_error, null)
  assert.equal(status.children, 0)
  assert.deepEqual(status.heads, { pilot: first, stable: null, upstream: { main: first } })
  assert.equal(mirror.tipSince('pilot'), new Date(T0).toISOString())
  assert.equal(mirror.tipSince('stable'), null)
  assert.ok(existsSync(join(dir, 'fleet.git', 'HEAD')))
  assert.ok(existsSync(join(dir, 'ring-tips.json')))
  assert.equal(existsSync(join(dir, 'allowed_signers')), false)
  const config = await repo.git(['config', '--list'], { cwd: join(dir, 'fleet.git') })
  for (const line of [
    'remote.upstream.fetch=+refs/heads/*:refs/remotes/upstream/*', 'remote.upstream.fetch=+refs/tags/*:refs/tags/*',
    'http.receivepack=false', 'http.getanyfile=false', 'http.uploadarchive=false', 'pack.threads=1',
    'gpg.format=ssh', `gpg.ssh.allowedsignersfile=${join(dir, 'allowed_signers')}`,
  ]) assert.ok(config.includes(line), line)
  assert.equal(config.includes('credential'), false, 'aucun credential dans la config du miroir')
})

test('stale après trois cadences sans fetch, puis ready après un fetch', async () => {
  clock = T0 + 901_000
  assert.equal(mirror.status().state, 'stale')
  assert.equal(mirror.status().fetch_age_s, 901)
  assert.equal(mirror.serving(), true)
  await mirror.fetch()
  assert.equal(mirror.status().state, 'ready')
})

test('pilot n’avance que sur une tête signée par un signataire autorisé', async () => {
  const signedTip = mirror.heads().pilot
  await mirror.configure({ rings: { pilot: { branch: 'main' }, stable: { branch: 'main' } }, allowed_signers: repo.allowedSigners })
  assert.equal(await readFile(join(dir, 'allowed_signers'), 'utf8'), repo.allowedSigners[0] + '\n')
  const unsigned = await repo.commit({ message: 'non signé', signed: false })
  clock = T0 + 1_000_000
  await mirror.fetch()
  assert.equal(mirror.heads().upstream.main, unsigned)
  assert.equal(mirror.heads().pilot, signedTip, 'pilot conservé')
  assert.equal(mirror.status().last_error, 'pilot: commit non signé par un signataire autorisé')
  assert.equal(mirror.status().state, 'ready')
  assert.equal(mirror.tipSince('pilot'), new Date(T0).toISOString())

  const stranger = await repo.commit({ message: 'signé par un inconnu', key: 'stranger' })
  await mirror.fetch()
  assert.equal(mirror.heads().pilot, signedTip)
  assert.equal(mirror.status().last_error, 'pilot: commit non signé par un signataire autorisé')

  const signed = await repo.commit({ message: 'signé' })
  clock = T0 + 2_000_000
  await mirror.fetch()
  assert.equal(mirror.heads().pilot, signed)
  assert.notEqual(signed, stranger)
  assert.equal(mirror.status().last_error, null)
  assert.equal(mirror.tipSince('pilot'), new Date(T0 + 2_000_000).toISOString())

  await mirror.configure({ rings: { pilot: { branch: 'main' }, stable: { branch: 'main' } }, allowed_signers: [] })
  assert.equal(existsSync(join(dir, 'allowed_signers')), false)
})

test('log() : sha, auteur, date ISO, sujet et signature (%G? seulement avec signataires)', async () => {
  const plain = await mirror.log('main', 3)
  assert.equal(plain.length, 3)
  assert.deepEqual(plain.map(c => c.subject), ['signé', 'signé par un inconnu', 'non signé'])
  assert.deepEqual(plain.map(c => c.signed), [null, null, null])
  assert.ok(plain.every(c => /^[0-9a-f]{40}$/.test(c.sha) && c.author === 'Flotte Test' && !Number.isNaN(Date.parse(c.date))))
  await mirror.writeAllowedSigners(repo.allowedSigners)
  const verified = await mirror.log('main', 4)
  assert.deepEqual(verified.map(c => [c.subject, c.signed]), [['signé', true], ['signé par un inconnu', false], ['non signé', false], ['initial', true]])
  assert.deepEqual(await mirror.log('inconnue'), [])
})

test('promoteStable : garde-fous NOT_ON_BRANCH, UNSIGNED, ROLLBACK, puis update-ref', async () => {
  const history = await mirror.log('main', 4)
  const [signed, stranger, unsigned, initial] = history.map(c => c.sha)
  await repo.checkout('feature', { from: 'main' })
  const feature = await repo.commit({ message: 'feature' })
  await repo.checkout('main')
  await mirror.fetch()
  assert.equal(mirror.heads().upstream.feature, feature)
  assert.equal(mirror.heads().stable, null, 'le fetch ne crée jamais stable')

  await assert.rejects(mirror.promoteStable(feature), { code: 'NOT_ON_BRANCH' })
  await assert.rejects(mirror.promoteStable('0'.repeat(40)), { code: 'NOT_ON_BRANCH' })
  await assert.rejects(mirror.promoteStable('pas-un-sha'), { code: 'NOT_ON_BRANCH' })
  await assert.rejects(mirror.promoteStable(unsigned), { code: 'UNSIGNED' })
  await assert.rejects(mirror.promoteStable(stranger), { code: 'UNSIGNED' })

  clock = T0 + 3_000_000
  assert.deepEqual(await mirror.promoteStable(initial), { before: null, after: initial })
  assert.equal(mirror.heads().stable, initial)
  assert.equal(mirror.tipSince('stable'), new Date(T0 + 3_000_000).toISOString())
  assert.deepEqual(await mirror.promoteStable(signed), { before: initial, after: signed })
  await assert.rejects(mirror.promoteStable(initial), { code: 'ROLLBACK' })
  assert.equal(mirror.heads().stable, signed)
  assert.deepEqual(await mirror.promoteStable(initial, { allowRollback: true }), { before: signed, after: initial })
  assert.deepEqual([...await mirror.stableAncestors()], [initial])
  assert.equal((await repo.git(['rev-parse', 'refs/heads/stable'], { cwd: join(dir, 'fleet.git') })), initial)

  await repo.commit({ message: 'après promotion' })
  await mirror.fetch()
  assert.equal(mirror.heads().stable, initial, 'stable jamais déplacé par un fetch')
})

test('listProfiles : profiles/*.yml du ring, slugs valides seulement', async () => {
  await mirror.writeAllowedSigners([])
  const tip = await repo.commit({ message: 'profils', files: {
    'profiles/admin.yml': '- hosts: localhost\n', 'profiles/field-researcher.yml': '---\n',
    'profiles/README.md': 'doc\n', 'profiles/Bad_Name.yml': '---\n', 'profiles/nested/x.yml': '---\n',
  } })
  await mirror.fetch()
  assert.equal(mirror.heads().pilot, tip)
  assert.deepEqual(await mirror.listProfiles('refs/heads/pilot'), ['admin', 'field-researcher'])
  assert.deepEqual(await mirror.listProfiles('refs/heads/stable'), [], 'stable pointe avant le dossier profiles')
  assert.deepEqual(await mirror.listProfiles('refs/remotes/upstream/main'), [])
})

test('redémarrage avec un miroir présent : ready sans contact upstream, têtes et tip_since restaurés', async () => {
  const heads = mirror.heads()
  const since = { pilot: mirror.tipSince('pilot'), stable: mirror.tipSince('stable') }
  const lastFetch = mirror.status().last_fetch_at
  mirror.stop()
  settings['linux.repo_url'] = ''
  const restarted = build()
  await restarted.start(fakeDb())
  assert.equal(restarted.status().state, 'ready')
  assert.deepEqual(restarted.heads(), heads)
  assert.deepEqual({ pilot: restarted.tipSince('pilot'), stable: restarted.tipSince('stable') }, since)
  assert.equal(restarted.status().last_fetch_at, lastFetch)
  assert.equal(restarted.status().upstream, null)
  restarted.stop()
  settings['linux.repo_url'] = repo.url
  mirror = build()
  await mirror.start(fakeDb())
})

test('branche de ring au nom hérité (__proto__, constructor) : jamais résolue, fetch et promotion sains', async () => {
  const pilot = mirror.heads().pilot
  await mirror.configure({ rings: { pilot: { branch: '__proto__' }, stable: { branch: 'constructor' } }, allowed_signers: [] })
  try {
    await mirror.fetch()
    assert.equal(mirror.status().state, 'ready')
    assert.equal(mirror.status().last_error, null)
    assert.equal(mirror.heads().pilot, pilot, 'pilot conservé')
    await assert.rejects(mirror.promoteStable(pilot), { code: 'NOT_ON_BRANCH' })
    assert.deepEqual(await mirror.log('constructor'), [])
  } finally {
    await mirror.configure({ rings: { pilot: { branch: 'main' }, stable: { branch: 'main' } }, allowed_signers: [] })
  }
})

test('redémarrage après un init sans fetch réussi : miroir vide non servi (absent), puis ready au premier fetch', async () => {
  const unfilled = join(repo.root, 'unfilled')
  const first = await detached({ dir: unfilled, deadlines: { clone: 5000 } })
  await assert.rejects(first.setUpstream('https://127.0.0.1:1/fleet.git'))
  assert.ok(existsSync(join(unfilled, 'fleet.git', 'config')), 'init fait, fetch échoué')
  first.stop()
  const restarted = build({ dir: unfilled })
  await restarted.start(fakeDb({ 'linux.repo_url': '' }))
  try {
    assert.equal(restarted.status().state, 'absent')
    assert.equal(restarted.serving(), false)
    assert.deepEqual(restarted.heads(), { pilot: null, stable: null, upstream: {} })
    await restarted.setUpstream(repo.url)
    assert.equal(restarted.status().state, 'ready')
    assert.equal(restarted.serving(), true)
  } finally {
    restarted.stop()
  }
})

test('setUpstream : re-pointage du remote puis fetch, identifiants masqués dans le statut', async () => {
  const other = await createFleetRepo()
  try {
    const tip = await other.commit({ message: 'autre dépôt' })
    await mirror.setUpstream(other.url)
    assert.deepEqual(mirror.heads().upstream, { main: tip })
    assert.equal(mirror.heads().pilot, tip)
    assert.equal(await repo.git(['remote', 'get-url', 'upstream'], { cwd: join(dir, 'fleet.git') }), other.url)
    await mirror.setUpstream(repo.url)
    assert.equal(mirror.status().upstream, repo.url)
    const broken = await detached({ dir: join(repo.root, 'unused'), deadlines: { clone: 5000 } })
    await assert.rejects(broken.setUpstream('https://user:secret@127.0.0.1:1/fleet.git'))
    assert.equal(broken.status().state, 'error')
    assert.equal(broken.status().upstream, 'https://127.0.0.1:1/fleet.git')
    broken.stop()
  } finally {
    await other.cleanup()
  }
})

test('échéance : fetch vers un serveur muet → GIT_TIMEOUT, aucun git-remote-http survivant', async () => {
  const server = net.createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const slow = await detached({ dir: join(repo.root, 'slow'), deadlines: { clone: 2000, fetch: 2000 } })
  try {
    const started = Date.now()
    await assert.rejects(slow.setUpstream(`http://127.0.0.1:${port}/fleet.git`), { code: 'GIT_TIMEOUT' })
    assert.ok(Date.now() - started < 10_000)
    assert.equal(slow.status().state, 'error')
    assert.equal(slow.status().last_error, 'GIT_TIMEOUT')
    const survivors = await execFile('pgrep', ['-f', `git-remote-http.*127.0.0.1:${port}`]).then(r => r.stdout, () => '')
    assert.equal(survivors.trim(), '', 'aucun helper git-remote-http orphelin')
  } finally {
    slow.stop()
    server.close()
  }
})

test('stop() tue l’enfant en cours au lieu d’attendre l’échéance', async () => {
  const server = net.createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const hanging = await detached({ dir: join(repo.root, 'hanging') })
  try {
    const pending = hanging.setUpstream(`http://127.0.0.1:${port}/fleet.git`)
    await new Promise(resolve => setTimeout(resolve, 500))
    hanging.stop()
    await assert.rejects(pending, { code: 'GIT_FAILED' })
    assert.equal(hanging.serving(), false)
    await assert.rejects(hanging.fetch(), { code: 'GIT_STOPPED' })
  } finally {
    server.close()
  }
})

test('binaires absents (ssh-keygen introuvable) → unavailable, aucune promotion possible', async () => {
  const bin = join(repo.root, 'bin')
  await mkdir(bin)
  const gitPath = (await execFile('sh', ['-c', 'command -v git'])).stdout.trim()
  await symlink(gitPath, join(bin, 'git'))
  const errors = []
  const crippled = build({ dir: join(repo.root, 'crippled'), path: bin })
  await crippled.start(fakeDb(), { error: (...args) => errors.push(args), warn() {} })
  assert.equal(crippled.status().state, 'unavailable')
  assert.equal(crippled.status().binaries_ok, false)
  assert.equal(crippled.serving(), false)
  assert.equal(errors.length, 1)
  await assert.rejects(crippled.promoteStable('0'.repeat(40)), { code: 'MIRROR_NOT_READY' })
  crippled.stop()
})
