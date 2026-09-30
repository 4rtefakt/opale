// Miroir git du dépôt de flotte (docs/linux-fleet-design.md §2 « Git mirror »).
//
// Un dépôt bare `$LINUX_GIT_DIR/fleet.git` suit l'upstream (`refs/remotes/upstream/*`),
// et Opale possède les deux branches de ring : `refs/heads/pilot` (avancée à chaque
// fetch sur la tête signée de sa branche) et `refs/heads/stable` (promotion explicite).
// États : absent | cloning | ready | stale | error | unavailable.
//
// Chaque enfant git est lancé détaché, avec un environnement minimal explicite
// (jamais process.env : il contient DATABASE_URL etc.) et une échéance appliquée
// au groupe de processus entier (un child.kill() seul orphelinerait git-remote-https).
import { spawn } from 'node:child_process'
import { existsSync, constants } from 'node:fs'
import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { nonOverlapping } from '../../../lib/non-overlapping.js'
import { readLinuxSettings } from './settings.js'

const CADENCE     = 300_000
const STALE_AFTER = 3 * CADENCE
const MAX_HTTP_CHILDREN = 8
const RINGS = ['pilot', 'stable']
// Le token n'est jamais dans l'URL ni dans la config du miroir : le helper lit l'env.
const CREDENTIAL_HELPER = '!f() { echo username=$LINUX_GIT_USER; echo password=$LINUX_GIT_TOKEN; }; f'
const failure = code => Object.assign(new Error(code), { code })

export function createGitMirror({
  dir = process.env.LINUX_GIT_DIR || '/app/data/git', now = Date.now, deadlines = {},
  path = process.env.PATH, home = process.env.HOME,
  token = process.env.LINUX_GIT_TOKEN, user = process.env.LINUX_GIT_USER,
} = {}) {
  const cwd = join(dir, 'fleet.git')
  const tipsFile = join(dir, 'ring-tips.json')
  const signersFile = join(dir, 'allowed_signers')
  const env = {
    PATH: path, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60',
    LINUX_GIT_TOKEN: token || '', LINUX_GIT_USER: user || 'oauth2',
  }
  const timeouts = { other: 30_000, fetch: 300_000, clone: 900_000, http: 300_000, ...deadlines }
  const children = new Set()
  let httpChildren = 0
  let state = 'absent'
  let binariesOk = false
  let populated = false
  let lastFetch = null
  let lastError = null
  let upstream = null
  let rings = { pilot: { branch: 'main' }, stable: { branch: 'main' } }
  let signers = []
  let cached = { pilot: null, stable: null, upstream: {} }
  let since = { pilot: null, stable: null }
  let timer = null, tick = null, started = null, stopped = false
  // Propriété propre seulement : un nom de branche comme `__proto__` ne doit jamais résoudre un héritage.
  const upstreamHead = branch => Object.hasOwn(cached.upstream, branch) ? cached.upstream[branch] : undefined

  // Les opérations qui écrivent dans le miroir (fetch, promote, set-url) sont sérialisées.
  let queue = Promise.resolve()
  const serial = fn => {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  }

  // Enfant déjà terminé : rien à faire. ESRCH = groupe disparu ; EPERM = zombie
  // pas encore moissonné (macOS) — dans les deux cas le groupe ne tourne plus.
  const kill = child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, 'SIGKILL') } catch (err) { if (!['ESRCH', 'EPERM'].includes(err.code)) throw err }
  }

  function child(args, childEnv, timeout, childCwd = cwd) {
    if (stopped) throw failure('GIT_STOPPED')
    const proc = spawn('git', args, { cwd: childCwd, detached: true, env: childEnv })
    children.add(proc)
    const deadline = setTimeout(() => { proc.gitTimedOut = true; kill(proc) }, timeout)
    deadline.unref()
    const cleanup = () => { clearTimeout(deadline); children.delete(proc) }
    proc.once('exit', cleanup)
    proc.once('error', cleanup)
    return proc
  }

  function run(args, { timeout = timeouts.other, cwd: workdir = cwd, codes = [0] } = {}) {
    return new Promise((resolve, reject) => {
      const proc = child(['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, ...args], env, timeout, workdir)
      const output = []
      proc.stdout.on('data', chunk => output.push(chunk))
      // stderr peut contenir l'URL upstream ou un message d'auth : jamais relayé.
      proc.stderr.resume()
      proc.stdin.end()
      proc.once('error', reject)
      proc.once('close', code => {
        if (proc.gitTimedOut) return reject(failure('GIT_TIMEOUT'))
        if (!codes.includes(code)) return reject(failure('GIT_FAILED'))
        resolve({ text: Buffer.concat(output).toString().trimEnd(), code })
      })
    })
  }

  async function persistTips() {
    const data = JSON.stringify({ heads: cached, since, last_fetch_at: lastFetch })
    await writeFile(tipsFile + '.tmp', data)
    await rename(tipsFile + '.tmp', tipsFile)
  }

  async function readHeads() {
    const { text } = await run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/upstream/'])
    const next = { pilot: null, stable: null, upstream: {} }
    for (const line of text.split('\n').filter(Boolean)) {
      const [ref, sha] = line.split(' ')
      // refs/remotes/upstream/HEAD (symref créée par git ≥ 2.48) n'est pas une branche.
      if (ref === 'refs/remotes/upstream/HEAD') continue
      if (ref.startsWith('refs/remotes/upstream/')) next.upstream[ref.slice('refs/remotes/upstream/'.length)] = sha
      else if (ref === 'refs/heads/pilot') next.pilot = sha
      else if (ref === 'refs/heads/stable') next.stable = sha
    }
    for (const ring of RINGS) {
      if (next[ring] !== cached[ring] || (next[ring] && !since[ring])) since[ring] = next[ring] ? new Date(now()).toISOString() : null
    }
    cached = next
    populated = true
    await persistTips()
  }

  async function writeAllowedSigners(lines) {
    await mkdir(dir, { recursive: true })
    if (lines.length) {
      await writeFile(signersFile + '.tmp', lines.join('\n') + '\n', { mode: 0o600 })
      await rename(signersFile + '.tmp', signersFile)
    } else await rm(signersFile, { force: true })
    signers = [...lines]
  }

  // Sans signataire configuré, tout est accepté ; sinon %G? doit valoir G (bon signataire autorisé).
  const signed = async sha => !signers.length || (await run(['log', '-1', '--format=%G?', sha])).text === 'G'
  const isAncestor = async (sha, ref) => !(await run(['merge-base', '--is-ancestor', sha, ref], { codes: [0, 1] })).code

  async function initMirror() {
    await mkdir(dir, { recursive: true })
    await run(['init', '--bare', cwd], { cwd: dir })
    await run(['remote', 'add', 'upstream', upstream])
    await run(['config', '--unset-all', 'remote.upstream.fetch'])
    for (const spec of ['+refs/heads/*:refs/remotes/upstream/*', '+refs/tags/*:refs/tags/*']) {
      await run(['config', '--add', 'remote.upstream.fetch', spec])
    }
    const config = {
      'http.receivepack': 'false', 'http.getanyfile': 'false', 'http.uploadarchive': 'false',
      'pack.threads': '1', 'gpg.format': 'ssh', 'gpg.ssh.allowedSignersFile': signersFile,
      'remote.upstream.followRemoteHEAD': 'never',
    }
    for (const [key, value] of Object.entries(config)) await run(['config', key, value])
  }

  async function fetchMirror() {
    if (!binariesOk) throw failure('MIRROR_NOT_READY')
    if (!upstream) return
    const initial = !existsSync(join(cwd, 'config'))
    if (initial) state = 'cloning'
    try {
      if (initial) await initMirror()
      else await run(['remote', 'set-url', 'upstream', upstream])
      await run(['fetch', '--prune', 'upstream'], { timeout: initial ? timeouts.clone : timeouts.fetch })
      lastFetch = now()
      lastError = null
      await readHeads()
      const pilot = upstreamHead(rings.pilot.branch)
      if (pilot && pilot !== cached.pilot) {
        if (await signed(pilot)) await run(['update-ref', 'refs/heads/pilot', pilot])
        else lastError = 'pilot: commit non signé par un signataire autorisé'
      }
      // refs/heads/stable n'est jamais déplacée par un fetch (promotion explicite).
      await readHeads()
      state = 'ready'
    } catch (err) {
      state = 'error'
      lastError = err.code || 'GIT_FAILED'
      throw err
    }
  }

  async function selfCheck() {
    const { text: execPath } = await run(['--exec-path'], { cwd: dir })
    if (!existsSync(join(execPath, 'git-http-backend'))) throw failure('GIT_BINARIES_MISSING')
    const found = await Promise.all((path || '').split(delimiter).filter(Boolean)
      .map(p => access(join(p, 'ssh-keygen'), constants.X_OK).then(() => true, () => false)))
    if (!found.some(Boolean)) throw failure('GIT_BINARIES_MISSING')
  }

  async function applySettings(db) {
    const settings = await readLinuxSettings(db)
    upstream = settings.repo_url
    rings = settings.rings
    await writeAllowedSigners(settings.allowed_signers)
  }

  // Le boot ne contacte jamais l'upstream : un miroir présent sur le volume est
  // servi dès la lecture de ses têtes ; le premier tick fait le fetch (ou le clone).
  async function boot(db, log) {
    await mkdir(dir, { recursive: true })
    try {
      await selfCheck()
      binariesOk = true
    } catch {
      state = 'unavailable'
      lastError = 'git-http-backend ou ssh-keygen indisponible'
      log?.error({ dir }, 'linux: miroir git indisponible, ' + lastError)
      return
    }
    await applySettings(db)
    if (!existsSync(join(cwd, 'config'))) return
    try {
      const saved = JSON.parse(await readFile(tipsFile, 'utf8'))
      cached = saved.heads
      since = saved.since
      lastFetch = saved.last_fetch_at ?? null
    } catch (err) { if (err.code !== 'ENOENT') throw err }
    await readHeads()
    // `config` existe dès l'init, avant le premier fetch : un miroir jamais rempli
    // (fetch initial échoué puis redémarrage) ne doit pas être servi vide.
    if (!Object.keys(cached.upstream).length) { populated = false; return }
    state = 'ready'
  }

  const api = {
    dir,
    heads: () => structuredClone(cached),
    tipSince: ring => since[ring],
    // Le miroir peut servir les clients dès qu'il a un contenu lu, même stale ou en erreur de fetch.
    serving: () => populated && !stopped && state !== 'unavailable',
    status() {
      const age = lastFetch === null ? null : Math.max(0, Math.floor((now() - lastFetch) / 1000))
      let url = upstream
      if (url) { try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; url = parsed.href } catch { url = null } }
      return {
        state: state === 'ready' && age !== null && age * 1000 > STALE_AFTER ? 'stale' : state,
        upstream: url,
        last_fetch_at: lastFetch === null ? null : new Date(lastFetch).toISOString(),
        fetch_age_s: age, last_error: lastError, heads: api.heads(),
        children: httpChildren, binaries_ok: binariesOk,
      }
    },
    fetch: () => serial(fetchMirror),
    // Tick immédiat (no-op si un tick tourne déjà) ; ne rejette jamais.
    sync: () => tick ? tick() : Promise.resolve(),
    setUpstream(url) {
      upstream = url
      return serial(fetchMirror)
    },
    // Rings et signataires s'appliquent sans attendre un fetch en cours : le fichier
    // est remplacé atomiquement, un `git log %G?` concurrent lit l'ancien ou le nouveau.
    writeAllowedSigners,
    async configure(settings) {
      rings = settings.rings
      await writeAllowedSigners(settings.allowed_signers)
    },
    promoteStable(sha, { allowRollback = false } = {}) {
      return serial(async () => {
        if (!api.serving()) throw failure('MIRROR_NOT_READY')
        const target = `refs/remotes/upstream/${rings.stable.branch}`
        if (!/^[0-9a-f]{40}$/.test(sha) || !upstreamHead(rings.stable.branch)) throw failure('NOT_ON_BRANCH')
        if ((await run(['cat-file', '-e', `${sha}^{commit}`], { codes: [0, 1, 128] })).code) throw failure('NOT_ON_BRANCH')
        if (!await isAncestor(sha, target)) throw failure('NOT_ON_BRANCH')
        if (!await signed(sha)) throw failure('UNSIGNED')
        const before = cached.stable
        if (before && before !== sha && !allowRollback && await isAncestor(sha, before)) throw failure('ROLLBACK')
        await run(['update-ref', 'refs/heads/stable', sha])
        await readHeads()
        return { before, after: sha }
      })
    },
    async log(branch, n = 50) {
      if (!Object.hasOwn(cached.upstream, branch)) return []
      const verify = signers.length > 0
      const format = '%H%x1f%an%x1f%aI%x1f%s' + (verify ? '%x1f%G?' : '')
      const { text } = await run(['log', '-n', String(n), `--format=${format}`, `refs/remotes/upstream/${branch}`])
      return text.split('\n').filter(Boolean).map(line => {
        const [sha, author, date, subject, signature] = line.split('\x1f')
        return { sha, author, date, subject, signed: verify ? signature === 'G' : null }
      })
    },
    async stableAncestors() {
      if (!cached.stable) return new Set()
      return new Set((await run(['rev-list', 'refs/heads/stable'])).text.split('\n').filter(Boolean))
    },
    async listProfiles(ref) {
      const ring = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
      if (!RINGS.includes(ring) || !cached[ring]) return []
      const result = await run(['ls-tree', '--name-only', `${ref}:profiles/`], { codes: [0, 128] })
      if (result.code) return []
      return result.text.split('\n').filter(name => /^[a-z0-9][a-z0-9-]{0,63}\.yml$/.test(name)).map(name => name.slice(0, -4))
    },
    // Sémaphore des enfants http-backend (assurance contre un device abusif, pas la charge nominale).
    acquireHttpSlot() {
      if (httpChildren >= MAX_HTTP_CHILDREN) return null
      httpChildren++
      let released = false
      return () => { if (!released) { released = true; httpChildren-- } }
    },
    // Variables CGI fournies par la route ; le reste de l'env est fixé ici.
    spawnHttp(vars) {
      return child(['http-backend'], { PATH: path, HOME: home, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', ...vars }, timeouts.http)
    },
    kill,
    start(db, log) {
      if (timer) return started
      stopped = false
      tick = nonOverlapping(() => serial(async () => {
        if (stopped || !binariesOk) return
        await applySettings(db)
        await fetchMirror()
      }), { onError: err => log?.warn({ code: err.code || 'GIT_FAILED' }, 'linux: échec de synchronisation du miroir git') })
      started = serial(() => boot(db, log)).catch(err => {
        state = 'error'
        lastError = err.code || 'GIT_BOOT_FAILED'
        log?.error({ err: err.message }, 'linux: échec du démarrage du miroir git')
      }).then(() => tick())
      timer = setInterval(tick, CADENCE)
      timer.unref()
      return started
    },
    // Tue les enfants en cours plutôt que d'attendre un fetch (jusqu'à 15 min).
    stop() {
      stopped = true
      clearInterval(timer)
      timer = null
      for (const proc of children) kill(proc)
    },
  }
  return api
}
