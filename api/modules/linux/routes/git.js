// Git smart HTTP en lecture seule pour les devices (préfixe /api/linux/agent/git)
// et routes admin du miroir (préfixe /api/linux : rings, promotion, statut, sync, profils).
// Design : docs/linux-fleet-design.md §4 (git) et §5.
import { Transform } from 'node:stream'
import { parseCgiResponse } from '../lib/cgi-response.js'
import { readLinuxSettings } from '../lib/settings.js'
import { ringSettled } from '../lib/device-view.js'
import { schemaFor } from '../lib/spec.js'
import { logAudit } from '../../core/lib/audit.js'

const BODY_LIMIT  = 4 * 1024 * 1024
const RETRY_AFTER = '30'
const CANDIDATES = 50

// Compteur d'octets ; onChunk renvoie une erreur pour interrompre le flux.
const counter = onChunk => new Transform({
  transform(chunk, encoding, callback) { callback(onChunk(chunk), chunk) },
})

export default async function gitAgentRoutes(fastify) {
  const { gitMirror, gitTokenStore } = fastify
  const rateLimit = { max: 30, timeWindow: '1 minute' }
  fastify.decorateRequest('gitDevice', null)
  // Le corps est remis tel quel au child : http-backend gère lui-même le gzip.
  fastify.addContentTypeParser('application/x-git-upload-pack-request', (req, payload, done) => done(null, payload))

  async function authorize(req, reply) {
    const auth = req.headers.authorization || ''
    const entry = auth.startsWith('Bearer ') ? gitTokenStore.verify(auth.slice(7)) : null
    if (!entry) return reply.code(401).send({ error: 'Token git invalide', code: 'TOKEN_INVALID' })
    if (entry.expired) return reply.code(401).send({ error: 'Token git expiré', code: 'TOKEN_EXPIRED' })
    // Révocation immédiate : la clé doit toujours être approuvée (index unique sur l'empreinte).
    const { rows } = await fastify.db.query('SELECT status FROM linux_device_keys WHERE key_fingerprint = $1', [entry.fingerprint])
    if (rows[0]?.status !== 'approved') return reply.code(401).send({ error: 'Clé révoquée', code: 'REVOKED' })
    req.gitDevice = entry
  }

  const unavailable = (reply, code, error) => reply.code(503).header('Retry-After', RETRY_AFTER).send({ error, code })

  // PATH_INFO est fixé par la route, jamais dérivé de la requête.
  async function proxy(req, reply, { pathInfo, queryString, hasBody = false }) {
    if (!gitMirror.serving()) return unavailable(reply, 'MIRROR_NOT_READY', 'Miroir git indisponible')
    const release = gitMirror.acquireHttpSlot()
    if (!release) return unavailable(reply, 'BUSY', 'Trop de clients git simultanés')
    const vars = { REQUEST_METHOD: req.method, PATH_INFO: pathInfo, QUERY_STRING: queryString }
    if (hasBody) {
      vars.CONTENT_TYPE = req.headers['content-type']
      if (req.headers['content-length'] !== undefined) vars.CONTENT_LENGTH = req.headers['content-length']
    }
    if (req.headers['content-encoding']) vars.HTTP_CONTENT_ENCODING = req.headers['content-encoding']
    if (req.headers['git-protocol']) vars.HTTP_GIT_PROTOCOL = req.headers['git-protocol']

    let child
    try {
      child = gitMirror.spawnHttp(vars)
    } catch {
      release()
      return unavailable(reply, 'MIRROR_NOT_READY', 'Miroir git indisponible')
    }
    const deviceId = req.gitDevice.deviceId
    let bytesIn = 0, bytesOut = 0, tooLarge = false
    const kill = () => gitMirror.kill(child)
    child.once('exit', code => {
      release()
      req.log.info({ device_id: deviceId, bytes_in: bytesIn, bytes_out: bytesOut, exit: code }, 'linux git: requête servie')
    })
    // Échec du spawn lui-même : pas d'`exit`, le slot doit quand même être rendu.
    child.once('error', () => { kill(); release() })
    child.stdin.on('error', () => {})   // EPIPE : le child a terminé (ou a été tué) avant la fin du corps
    child.stderr.resume()
    // Client parti (pendant le corps ou la réponse) : `close` de la réponse, pas de la requête —
    // depuis Node 16, IncomingMessage émet `close` dès que le corps est consommé.
    reply.raw.once('close', kill)
    reply.raw.once('error', kill)

    // Plafond propre au corps : bodyLimit de Fastify ne s'applique pas à un parser passthrough.
    // pipe() plutôt que pipeline() : un dépassement ne doit pas détruire la socket avant le 413.
    const input = new Promise(resolve => {
      if (!hasBody) return child.stdin.end(resolve)
      const limit = counter(chunk => {
        bytesIn += chunk.length
        if (bytesIn > BODY_LIMIT) { tooLarge = true; return new Error('PAYLOAD_TOO_LARGE') }
      })
      limit.once('error', () => { req.body.unpipe(limit); resolve() })
      child.stdin.once('finish', resolve)
      child.stdin.once('close', resolve)
      req.body.once('error', resolve)
      req.body.pipe(limit).pipe(child.stdin)
    })
    // http-backend écrit ses en-têtes avant de lire le corps : on attend la fin du corps
    // pour pouvoir encore répondre 413 (le child bufferise l'entrée, pas de blocage).
    const [, cgi] = await Promise.allSettled([input, parseCgiResponse(child.stdout)])
    if (tooLarge) {
      kill()
      return reply.code(413).send({ error: 'Corps de requête trop volumineux (max 4 MiB)', code: 'PAYLOAD_TOO_LARGE' })
    }
    if (cgi.status === 'rejected') {
      kill()
      req.log.error({ device_id: deviceId, err: cgi.reason.message }, 'linux git: réponse CGI invalide')
      return reply.code(500).send({ error: 'Erreur interne' })
    }
    const { status, headers, body } = cgi.value
    const output = counter(chunk => { bytesOut += chunk.length })
    body.once('error', err => output.destroy(err))
    body.pipe(output)
    return reply.code(status).headers(headers).send(output)
  }

  fastify.get('/fleet.git/info/refs', {
    config: { operationId: 'linuxAgentGitInfoRefs', rateLimit },
    preHandler: authorize,
  }, async (req, reply) => {
    if (req.query.service !== 'git-upload-pack') {
      return reply.code(403).send({ error: 'Service git non autorisé', code: 'SERVICE_FORBIDDEN' })
    }
    return proxy(req, reply, { pathInfo: '/fleet.git/info/refs', queryString: 'service=git-upload-pack' })
  })

  fastify.post('/fleet.git/git-upload-pack', {
    config: { operationId: 'linuxAgentGitUploadPack', rateLimit },
    preHandler: authorize,
  }, async (req, reply) => {
    // Seul le parser passthrough ci-dessus fournit un flux ; tout autre content-type (ou corps absent) est refusé.
    if (typeof req.body?.pipe !== 'function') {
      return reply.code(415).send({ error: 'Content-Type git attendu', code: 'UNSUPPORTED_MEDIA_TYPE' })
    }
    return proxy(req, reply, { pathInfo: '/fleet.git/git-upload-pack', queryString: '', hasBody: true })
  })
}

const PROMOTE_ERRORS = {
  NOT_ON_BRANCH:    'Révision inconnue ou absente de la branche upstream du ring stable',
  UNSIGNED:         'Révision non signée par un signataire autorisé',
  ROLLBACK:         'Révision antérieure au stable actuel : confirmer le retour arrière (allow_rollback)',
  MIRROR_NOT_READY: 'Miroir git indisponible',
}

export async function gitAdminRoutes(fastify) {
  const { gitMirror, db } = fastify
  const admin       = [fastify.authenticate, fastify.requireAdmin]
  const interactive = [...admin, fastify.requireInteractive]

  async function successCounts(shas) {
    if (!shas.length) return {}
    const { rows } = await db.query(`
      SELECT r.revision, d.ring, count(DISTINCT r.device_id)::int AS devices
      FROM linux_apply_reports r
      JOIN devices d ON d.id = r.device_id
      WHERE r.status = 'success' AND r.revision = ANY($1::text[]) AND d.ring IN ('pilot', 'stable')
      GROUP BY r.revision, d.ring
    `, [shas])
    const counts = {}
    for (const row of rows) (counts[row.revision] ??= { pilot: 0, stable: 0 })[row.ring] = row.devices
    return counts
  }

  // `lagging` : définition unique (ringSettled, design §5), la même que la liste des postes.
  async function ringInfos(settings) {
    const heads = gitMirror.heads()
    const serving = gitMirror.serving()
    const { rows: counts } = await db.query(`
      SELECT ring,
             count(*)::int AS total,
             count(*) FILTER (WHERE last_successful_revision = CASE ring WHEN 'pilot' THEN $1::text ELSE $2::text END)::int AS on_tip,
             count(*) FILTER (WHERE last_successful_revision IS DISTINCT FROM CASE ring WHEN 'pilot' THEN $1::text ELSE $2::text END)::int AS behind,
             count(*) FILTER (WHERE last_apply_status IN ('failed', 'partial'))::int AS failed
      FROM devices
      WHERE managed_by = 'pull' AND ring IN ('pilot', 'stable')
      GROUP BY ring
    `, [heads.pilot, heads.stable])
    const logs = {}
    for (const ring of ['pilot', 'stable']) {
      const { branch } = settings.rings[ring]
      logs[branch] ??= serving ? await gitMirror.log(branch, CANDIDATES) : []
    }
    const shas = [...new Set(Object.values(logs).flat().map(c => c.sha))]
    const [successes, stableAncestors] = await Promise.all([successCounts(shas), serving ? gitMirror.stableAncestors() : new Set()])
    const result = {}
    for (const ring of ['pilot', 'stable']) {
      const { branch } = settings.rings[ring]
      const stats = counts.find(row => row.ring === ring) ?? { total: 0, on_tip: 0, behind: 0, failed: 0 }
      const settled = serving && ringSettled(gitMirror, ring)
      result[ring] = {
        ring, branch, tip: heads[ring], tip_since: gitMirror.tipSince(ring),
        upstream_head: Object.hasOwn(heads.upstream, branch) ? heads.upstream[branch] : null,
        devices: { total: stats.total, on_tip: stats.on_tip, lagging: settled ? stats.behind : 0, failed: stats.failed },
        candidates: logs[branch].map(c => ({
          ...c, success_pilot: successes[c.sha]?.pilot ?? 0, success_stable: successes[c.sha]?.stable ?? 0,
          // La tête stable elle-même n'est pas un retour arrière (promoteStable l'exempte de ROLLBACK).
          is_ancestor_of_stable: c.sha !== heads.stable && stableAncestors.has(c.sha),
        })),
      }
    }
    return result
  }

  fastify.get('/rings', {
    schema: schemaFor('linuxGetRings'), config: { operationId: 'linuxGetRings' }, preHandler: admin,
  }, async () => {
    const rings = await ringInfos(await readLinuxSettings(db))
    return { ...rings, mirror_state: gitMirror.status().state }
  })

  fastify.post('/rings/stable/promote', {
    schema: schemaFor('linuxPromoteStable'), config: { operationId: 'linuxPromoteStable' }, preHandler: interactive,
  }, async (req, reply) => {
    const { revision, allow_rollback = false } = req.body
    let result
    try {
      result = await gitMirror.promoteStable(revision, { allowRollback: allow_rollback })
    } catch (err) {
      if (!PROMOTE_ERRORS[err.code]) throw err
      return reply.code(409).send({ error: PROMOTE_ERRORS[err.code], code: err.code })
    }
    const { displayName } = fastify.getUserIdentity(req)
    await logAudit(db, fastify.log, {
      action: 'linux_ring_promoted', byUser: displayName, target: 'stable',
      details: { before: result.before, after: result.after, allow_rollback },
    })
    return (await ringInfos(await readLinuxSettings(db))).stable
  })

  fastify.get('/git/status', {
    schema: schemaFor('linuxGitStatus'), config: { operationId: 'linuxGitStatus' }, preHandler: admin,
  }, async () => gitMirror.status())

  fastify.post('/git/sync', {
    schema: schemaFor('linuxGitSync'), config: { operationId: 'linuxGitSync' }, preHandler: interactive,
  }, async (req, reply) => {
    gitMirror.sync()
    const { displayName } = fastify.getUserIdentity(req)
    await logAudit(db, fastify.log, { action: 'linux_git_synced', byUser: displayName })
    return reply.code(202).send(gitMirror.status())
  })

  fastify.get('/profiles', {
    schema: schemaFor('linuxListProfiles'), config: { operationId: 'linuxListProfiles' }, preHandler: admin,
  }, async () => {
    const [pilot, stable, { rows }] = await Promise.all([
      gitMirror.listProfiles('refs/heads/pilot'),
      gitMirror.listProfiles('refs/heads/stable'),
      db.query(`SELECT profile, count(*)::int AS devices FROM devices WHERE managed_by = 'pull' AND profile IS NOT NULL GROUP BY profile`),
    ])
    const devices = Object.fromEntries(rows.map(row => [row.profile, row.devices]))
    const slugs = [...new Set([...pilot, ...stable])].sort()
    return {
      rows: slugs.map(slug => ({ slug, in_pilot: pilot.includes(slug), in_stable: stable.includes(slug), devices: devices[slug] ?? 0 })),
      mirror_state: gitMirror.status().state,
    }
  })
}
