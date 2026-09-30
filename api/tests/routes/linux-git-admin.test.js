// Routes admin du miroir git (préfixe /api/linux) : /rings, promotion de stable,
// /git/status, /git/sync, /profiles et /settings — vrai miroir git sur un dépôt
// de flotte temporaire, base réelle pour les compteurs, l'audit et les settings.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'
import { seedDevice } from '../fixtures/devices.js'
import { createFleetRepo } from '../helpers/linux-fleet-repo.js'
import { createGitMirror } from '../../modules/linux/lib/git-mirror.js'
import { gitAdminRoutes } from '../../modules/linux/routes/git.js'
import settingsRoutes from '../../modules/linux/routes/settings.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini — skip routes admin git'
const ADMIN = { entraId: 'oid-linux-git-admin', displayName: 'Admin Git', email: 'git-admin@test.local' }
const ZERO = '0'.repeat(40)

let db, release, jwt, app, repo, mirror, adminToken, cliToken, userToken
let c1, c2
// Horloge du miroir : une heure dans le passé, pour que tip_since soit « installé »
// (> 2 fenêtres de check-in) et que le calcul de lagging s'applique.
let clock = Date.now() - 3_600_000
const devices = {}

before(async () => {
  if (SKIP) return
  const acquired = await acquireSchema()
  db = acquired.db
  release = acquired.release
  jwt = await setupTestJwks()
  repo = await createFleetRepo()
  c1 = await repo.commit({ message: 'initial', files: { 'README.md': 'flotte\n' } })
  c2 = await repo.commit({ message: 'profils', files: { 'profiles/admin.yml': '---\n', 'profiles/field.yml': '---\n' } })
  await db.query("UPDATE settings SET value = $1 WHERE key = 'linux.repo_url'", [repo.url])
  mirror = createGitMirror({ dir: join(repo.root, 'mirror'), home: repo.home, now: () => clock })
  await mirror.start(db)
  assert.equal(mirror.status().state, 'ready')

  await seedAdmin(db, ADMIN)
  adminToken = await jwt.sign({ oid: ADMIN.entraId, name: ADMIN.displayName, preferred_username: ADMIN.email })
  const user = await seedNonAdmin(db, { entraId: 'oid-linux-git-user' })
  userToken = await jwt.sign({ oid: user.entraId, name: user.displayName, preferred_username: user.email })
  // Token CLI d'un admin : requireAdmin passe, requireInteractive refuse.
  const secret = crypto.randomBytes(32).toString('hex')
  await db.query('INSERT INTO cli_tokens (entra_id, label, token_hash) VALUES ($1, $2, $3)',
    [ADMIN.entraId, 'test', crypto.createHash('sha256').update(secret).digest('hex')])
  cliToken = 'opl_' + secret

  // Postes : stable ×2 (un sur c1, un en échec sans révision), pilot ×2 (un sur la tête, un en retard).
  devices.s1 = await seedDevice(db, { hostname: 'lx-s1', platform: 'linux', managed_by: 'pull', ring: 'stable', profile: 'admin' })
  devices.s2 = await seedDevice(db, { hostname: 'lx-s2', platform: 'linux', managed_by: 'pull', ring: 'stable' })
  devices.p1 = await seedDevice(db, { hostname: 'lx-p1', platform: 'linux', managed_by: 'pull', ring: 'pilot', profile: 'admin' })
  devices.p2 = await seedDevice(db, { hostname: 'lx-p2', platform: 'linux', managed_by: 'pull', ring: 'pilot', profile: 'ghost' })
  await seedDevice(db, { hostname: 'PC-WIN', profile: 'admin' })
  for (const [id, revision, status] of [[devices.s1.id, c1, 'success'], [devices.s2.id, null, 'failed'], [devices.p1.id, c2, 'success'], [devices.p2.id, c1, 'success']]) {
    await db.query('UPDATE devices SET last_successful_revision = $2, last_apply_status = $3 WHERE id = $1', [id, revision, status])
    if (revision) await db.query("INSERT INTO linux_apply_reports (device_id, revision, status) VALUES ($1, $2, 'success')", [id, revision])
  }

  app = await buildApp({
    db, jwks: jwt.jwks,
    decorators: { gitMirror: mirror },
    routes: async f => {
      await f.register(gitAdminRoutes, { prefix: '/api/linux' })
      await f.register(settingsRoutes, { prefix: '/api/linux' })
    },
  })
})

after(async () => {
  if (app) await app.close()
  mirror?.stop()
  if (release) await release()
  await closeSharedPool()
  await repo?.cleanup()
})

const call = (method, url, { token = adminToken, payload } = {}) =>
  app.inject({ method, url: '/api/linux' + url, headers: { authorization: `Bearer ${token}` }, payload })

const audits = async action => (await db.query('SELECT by_user, target, details FROM audit_logs WHERE action = $1 ORDER BY created_at', [action])).rows

test('GET /rings : têtes, compteurs par ring, candidats avec succès et signature', { skip: SKIP }, async () => {
  const res = await call('GET', '/rings')
  assert.equal(res.statusCode, 200, res.body)
  const { pilot, stable, mirror_state } = res.json()
  assert.equal(mirror_state, 'ready')
  assert.equal(pilot.branch, 'main')
  assert.equal(pilot.tip, c2)
  assert.equal(pilot.upstream_head, c2)
  assert.ok(pilot.tip_since)
  assert.deepEqual(pilot.devices, { total: 2, on_tip: 1, lagging: 1, failed: 0 })
  // Stable jamais promu : pas de tête, donc pas de retard mesurable.
  assert.equal(stable.tip, null)
  assert.equal(stable.tip_since, null)
  assert.equal(stable.upstream_head, c2)
  assert.deepEqual(stable.devices, { total: 2, on_tip: 0, lagging: 0, failed: 1 })
  assert.deepEqual(pilot.candidates.map(c => c.sha), [c2, c1])
  assert.deepEqual(pilot.candidates, stable.candidates)
  const [top, initial] = pilot.candidates
  assert.equal(top.subject, 'profils')
  assert.equal(top.author, 'Flotte Test')
  assert.ok(!Number.isNaN(Date.parse(top.date)))
  assert.equal(top.signed, null, 'aucun signataire configuré')
  assert.deepEqual([top.success_pilot, top.success_stable, top.is_ancestor_of_stable], [1, 0, false])
  assert.deepEqual([initial.success_pilot, initial.success_stable, initial.is_ancestor_of_stable], [1, 1, false])
})

test('routes admin : 401 sans token, 403 pour un non-admin', { skip: SKIP }, async () => {
  assert.equal((await app.inject({ url: '/api/linux/rings' })).statusCode, 401)
  for (const [method, url] of [['GET', '/rings'], ['GET', '/git/status'], ['GET', '/profiles'], ['GET', '/settings'], ['POST', '/git/sync']]) {
    assert.equal((await call(method, url, { token: userToken })).statusCode, 403, `${method} ${url}`)
  }
})

test('POST /rings/stable/promote : session interactive, garde-fous 409, audit avant/après', { skip: SKIP }, async () => {
  const cli = await call('POST', '/rings/stable/promote', { token: cliToken, payload: { revision: c2 } })
  assert.equal(cli.statusCode, 403)
  assert.equal(cli.json().code, 'INTERACTIVE_ONLY')
  assert.equal((await call('POST', '/rings/stable/promote', { payload: { revision: 'abc' } })).statusCode, 400)
  const unknown = await call('POST', '/rings/stable/promote', { payload: { revision: ZERO } })
  assert.equal(unknown.statusCode, 409)
  assert.equal(unknown.json().code, 'NOT_ON_BRANCH')

  const promoted = await call('POST', '/rings/stable/promote', { payload: { revision: c2 } })
  assert.equal(promoted.statusCode, 200, promoted.body)
  assert.equal(promoted.json().ring, 'stable')
  assert.equal(promoted.json().tip, c2)
  assert.equal(mirror.heads().stable, c2)
  // c1 est un vrai ancêtre du stable (retour arrière) ; la tête c2 elle-même n'en est pas un.
  assert.deepEqual(promoted.json().candidates.map(c => [c.sha, c.is_ancestor_of_stable]), [[c2, false], [c1, true]])

  const rollback = await call('POST', '/rings/stable/promote', { payload: { revision: c1 } })
  assert.equal(rollback.statusCode, 409)
  assert.equal(rollback.json().code, 'ROLLBACK')
  const forced = await call('POST', '/rings/stable/promote', { payload: { revision: c1, allow_rollback: true } })
  assert.equal(forced.statusCode, 200, forced.body)
  assert.equal(forced.json().tip, c1)
  // Retour sur c1 : s1 est sur la tête, s2 (sans révision) est en retard ; c1 est la tête (pas un
  // retour arrière), c2 est en avant.
  assert.deepEqual(forced.json().devices, { total: 2, on_tip: 1, lagging: 1, failed: 1 })
  assert.deepEqual(forced.json().candidates.map(c => [c.sha, c.is_ancestor_of_stable]), [[c2, false], [c1, false]])

  const rows = await audits('linux_ring_promoted')
  assert.deepEqual(rows.map(r => [r.by_user, r.target, r.details]), [
    [ADMIN.displayName, 'stable', { before: null, after: c2, allow_rollback: false }],
    [ADMIN.displayName, 'stable', { before: c2, after: c1, allow_rollback: true }],
  ])
})

test('GET /git/status : forme GitStatus du miroir prêt', { skip: SKIP }, async () => {
  const res = await call('GET', '/git/status')
  assert.equal(res.statusCode, 200, res.body)
  const status = res.json()
  assert.equal(status.state, 'ready')
  assert.equal(status.upstream, repo.url)
  assert.ok(!Number.isNaN(Date.parse(status.last_fetch_at)))
  assert.equal(typeof status.fetch_age_s, 'number')
  assert.equal(status.last_error, null)
  assert.deepEqual(status.heads, { pilot: c2, stable: c1, upstream: { main: c2 } })
  assert.equal(status.children, 0)
  assert.equal(status.binaries_ok, true)
})

test('signataires + POST /git/sync : tête non signée refusée pour pilot, promotion UNSIGNED, candidats signés', { skip: SKIP }, async () => {
  const patched = await call('PATCH', '/settings', { payload: { allowed_signers: repo.allowedSigners } })
  assert.equal(patched.statusCode, 200, patched.body)
  assert.deepEqual(patched.json().allowed_signers, repo.allowedSigners)
  assert.equal(await readFile(join(repo.root, 'mirror', 'allowed_signers'), 'utf8'), repo.allowedSigners[0] + '\n')

  const c3 = await repo.commit({ message: 'non signé', signed: false })
  assert.equal((await call('POST', '/git/sync', { token: cliToken })).statusCode, 403)
  const sync = await call('POST', '/git/sync')
  assert.equal(sync.statusCode, 202, sync.body)
  assert.equal(sync.json().state, 'ready')
  await mirror.sync()
  assert.equal((await audits('linux_git_synced')).length, 1)
  assert.equal(mirror.heads().upstream.main, c3)
  assert.equal(mirror.heads().pilot, c2, 'pilot conservé sur la dernière tête signée')
  assert.equal((await call('GET', '/git/status')).json().last_error, 'pilot: commit non signé par un signataire autorisé')

  const unsigned = await call('POST', '/rings/stable/promote', { payload: { revision: c3 } })
  assert.equal(unsigned.statusCode, 409)
  assert.equal(unsigned.json().code, 'UNSIGNED')
  const { stable } = (await call('GET', '/rings')).json()
  assert.deepEqual(stable.candidates.map(c => [c.sha, c.signed]), [[c3, false], [c2, true], [c1, true]])
})

test('GET /profiles : profils du dépôt à la tête de chaque ring, postes par slug', { skip: SKIP }, async () => {
  const res = await call('GET', '/profiles')
  assert.equal(res.statusCode, 200, res.body)
  // pilot = c2 (dossier profiles/), stable = c1 (avant) ; « ghost » n'existe pas dans le dépôt.
  assert.deepEqual(res.json(), {
    rows: [
      { slug: 'admin', in_pilot: true, in_stable: false, devices: 2 },
      { slug: 'field', in_pilot: true, in_stable: false, devices: 0 },
    ],
    mirror_state: 'ready',
  })
})

test('GET /settings : valeurs, nom du compte local depuis agent.laps_recovery_username, escrow stub', { skip: SKIP }, async () => {
  const before = (await call('GET', '/settings')).json()
  assert.deepEqual(before, {
    repo_url: repo.url, allowed_signers: repo.allowedSigners, alerts_enabled: false,
    rings: { pilot: { branch: 'main' }, stable: { branch: 'main' } },
    local_admin_username: 'opale-recovery',
    escrow: { status: 'unavailable', key_id: null, bits: null, backup_confirmed: null },
  })
  await db.query("INSERT INTO settings (key, value) VALUES ('agent.laps_recovery_username', 'adm-local') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
  assert.equal((await call('GET', '/settings')).json().local_admin_username, 'adm-local')
})

test('PATCH /settings : validation (corps vide, ssh, branche inconnue ou invalide), session interactive', { skip: SKIP }, async () => {
  const cli = await call('PATCH', '/settings', { token: cliToken, payload: { alerts_enabled: true } })
  assert.equal(cli.statusCode, 403)
  assert.equal(cli.json().code, 'INTERACTIVE_ONLY')
  for (const payload of [{}, { repo_url: 'ssh://git@example.com/fleet.git' }, { repo_url: 'https://user:pw@example.com/fleet.git' }]) {
    assert.equal((await call('PATCH', '/settings', { payload })).statusCode, 400, JSON.stringify(payload))
  }
  const unknown = await call('PATCH', '/settings', { payload: { rings: { pilot: { branch: 'nope' } } } })
  assert.equal(unknown.statusCode, 400)
  assert.equal(unknown.json().error, 'Branche inconnue : nope')
  const invalid = await call('PATCH', '/settings', { payload: { rings: { stable: { branch: 'a..b' } } } })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error, 'Nom de branche invalide')
  assert.equal((await audits('linux_settings_changed')).length, 1, 'aucun audit pour un refus')
})

test('PATCH /settings : branche de ring et alertes, audit avant/après par clé, pilot suit la nouvelle branche', { skip: SKIP }, async () => {
  await repo.checkout('feature', { from: 'main' })
  const feature = await repo.commit({ message: 'feature' })
  await repo.checkout('main')
  await mirror.fetch()

  const res = await call('PATCH', '/settings', { payload: { alerts_enabled: true, rings: { pilot: { branch: 'feature' } } } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().alerts_enabled, true)
  assert.deepEqual(res.json().rings, { pilot: { branch: 'feature' }, stable: { branch: 'main' } })
  const { rows } = await db.query("SELECT key, value, updated_by FROM settings WHERE key IN ('linux.alerts_enabled', 'linux.ring.pilot') ORDER BY key")
  assert.deepEqual(rows, [
    { key: 'linux.alerts_enabled', value: 'true', updated_by: ADMIN.displayName },
    { key: 'linux.ring.pilot', value: '{"branch":"feature"}', updated_by: ADMIN.displayName },
  ])
  const [, changed] = await audits('linux_settings_changed')
  assert.equal(changed.by_user, ADMIN.displayName)
  assert.deepEqual(changed.details, { changes: {
    alerts_enabled: { before: false, after: true },
    'rings.pilot.branch': { before: 'main', after: 'feature' },
  } })
  // Même valeurs → aucune écriture ni audit.
  assert.equal((await call('PATCH', '/settings', { payload: { alerts_enabled: true } })).statusCode, 200)
  assert.equal((await audits('linux_settings_changed')).length, 2)

  await mirror.fetch()
  assert.equal(mirror.heads().pilot, feature)
  assert.equal((await call('GET', '/rings')).json().pilot.branch, 'feature')
})

test('PATCH /settings : changement de repo_url → remote re-pointé et fetch en arrière-plan', { skip: SKIP }, async () => {
  const url = 'https://127.0.0.1:1/fleet.git'
  const res = await call('PATCH', '/settings', { payload: { repo_url: url } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().repo_url, url)
  assert.equal(mirror.status().upstream, url)
  const deadline = Date.now() + 10_000
  while (mirror.status().state !== 'error' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(mirror.status().state, 'error', 'le fetch vers le nouvel upstream a échoué')
  assert.equal(await repo.git(['remote', 'get-url', 'upstream'], { cwd: join(repo.root, 'mirror', 'fleet.git') }), url)
  const [, , changed] = await audits('linux_settings_changed')
  assert.deepEqual(changed.details, { changes: { repo_url: { before: repo.url, after: url } } })
  // Le miroir en erreur sert toujours son dernier contenu.
  assert.equal((await call('GET', '/rings')).json().mirror_state, 'error')
  await mirror.setUpstream(repo.url)
  assert.equal(mirror.status().state, 'ready')
})
