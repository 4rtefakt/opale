import crypto from 'crypto'
import fs     from 'fs'
import path   from 'path'
import { fileURLToPath } from 'url'
import { sendPushToAll } from '../../core/routes/push.js'
import { makeAgentConn, WS_FRAME_MAX_BYTES, WS_CLOSE, wsReasonFromCode } from '../lib/agent-ws.js'
import { evaluateAndPersist as evaluateCompliance } from '../../monitoring/lib/compliance.js'
import { logAudit } from '../../core/lib/audit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Agent Go : binaire compilé + clé privée de signature ─────────────────
// Layout :
//   • Local dev : /repo/api/modules/inventory/routes/agent.js → /repo/agent-go (4 levels up)
//   • Docker    : /app/modules/inventory/routes/agent.js     → /app/agent-go  (3 levels up)
// Override via AGENT_GO_DIR si layout custom.
const AGENT_GO_DIR = process.env.AGENT_GO_DIR ||
  (fs.existsSync(path.join(__dirname, '..', '..', '..', 'agent-go'))
    ? path.join(__dirname, '..', '..', '..', 'agent-go')
    : path.join(__dirname, '..', '..', '..', '..', 'agent-go'))
// Matrice multi-arch : on glob les binaires présents dans dist/. Le suffixe
// d'arch est stripped pour calculer le chemin "legacy" sans suffixe (compat
// agents qui ont reçu un binaire pré-matrix-arch et ne précisent pas l'arch).
const VALID_ARCH = new Set(['amd64', 'arm64', '386'])

function agentBinPath(arch) {
  // Défense en profondeur : whitelist avant le glob. Le glob filesystem
  // empêche déjà un path traversal classique (il ne trouverait pas de
  // fichier avec un nom contenant `..`), mais la whitelist évite que ce
  // soit la dernière ligne de défense.
  if (!VALID_ARCH.has(arch)) return null
  let entries = []
  try { entries = fs.readdirSync(path.join(AGENT_GO_DIR, 'dist')) } catch { return null }
  const archMatch = entries.find(n => n.endsWith(`-${arch}.exe`))
  if (archMatch) return path.join(AGENT_GO_DIR, 'dist', archMatch)
  if (arch === 'amd64') {
    // Fallback : un binaire sans suffixe d'arch (copie amd64 produite par build.js)
    const plain = entries.find(n => n.endsWith('.exe') && !/-(amd64|arm64|386)\.exe$/.test(n))
    if (plain) return path.join(AGENT_GO_DIR, 'dist', plain)
  }
  return null
}
// La version vit en sidecar dans dist/ (regénérée par build.js depuis
// version.go). Lue à chaque cache miss — pas via mount single-file pour
// éviter les problèmes d'inode-tracking de Docker.
const AGENT_VER_PATH  = process.env.AGENT_GO_VERSION_FILE || path.join(AGENT_GO_DIR, 'dist', 'agent-version.txt')
const AGENT_KEY_PATH  = process.env.AGENT_SIGNING_KEY || path.join(AGENT_GO_DIR, 'keys', 'signing.key')

// Cache par arch — { amd64: {...}, arm64: {...} }
const binCache = {}

// archFromUA — détection à partir du User-Agent reporté par l'agent.
// Fallback sur amd64 (compat agents pre-2.10 qui ne reportent pas l'arch).
function archFromUA(ua) {
  if (!ua) return 'amd64'
  const m = ua.match(/\((?:windows|linux|darwin)\/(\w+)\)/)
  return (m && /^(amd64|arm64|386)$/.test(m[1])) ? m[1] : 'amd64'
}

function readGoAgentVersion() {
  try {
    const content = fs.readFileSync(AGENT_VER_PATH, 'utf8').trim()
    // Compat : si on lit version.go (cas legacy/dev), parser la const ;
    // sinon (sidecar dist/agent-version.txt), c'est juste "X.Y.Z".
    const m = content.match(/AgentVersion\s*=\s*"([^"]+)"/)
    if (m) return m[1]
    return content || null
  } catch {
    return null
  }
}

function loadSigningKey() {
  // Lue à chaque (rare) cache miss pour éviter de garder la clé en RAM
  // pendant toute la durée de vie du process.
  return fs.readFileSync(AGENT_KEY_PATH, 'utf8')
}

function getAgentBinaryMeta(arch = 'amd64') {
  const binPath = agentBinPath(arch)
  if (!binPath) return null

  let st
  try { st = fs.statSync(binPath) } catch { return null }

  const cached = binCache[arch]
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached
  }

  const body    = fs.readFileSync(binPath)
  const sha256  = crypto.createHash('sha256').update(body).digest('hex')
  const version = readGoAgentVersion() || 'unknown'

  let signature = null
  try {
    const key = loadSigningKey()
    signature = crypto.sign(null, body, key).toString('base64')
  } catch (err) {
    return { error: `signing key indisponible : ${err.message}` }
  }

  // Le filename remonté côté Content-Disposition reprend le nom du binaire
  // sur disque (cohérent avec le branding utilisé au build).
  const filename = path.basename(binPath)

  binCache[arch] = { arch, mtimeMs: st.mtimeMs, size: st.size, version, sha256, signature, filename, body }
  return binCache[arch]
}

// Maintenance window — sémantique strictement identique à
// agent-go/maintenance.go (cf. tests Go MaintenanceWindow_*).
// Fail-open : tout input invalide ou vide ⇒ toujours actif.
function isMaintenanceWindowActive(w, now) {
  if (!w || (typeof w !== 'object')) return true
  const hasFields = (w.weekdays && w.weekdays.length) || w.start || w.end
  if (!hasFields) return true

  // Convertir `now` dans la TZ déclarée (par défaut UTC).
  const tz = w.tz || 'UTC'
  let local
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
    const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    local = {
      weekday: wdMap[parts.weekday],
      hour:    parseInt(parts.hour, 10) % 24,
      minute:  parseInt(parts.minute, 10),
    }
  } catch {
    return true // TZ invalide → fail-open
  }

  if (Array.isArray(w.weekdays) && w.weekdays.length > 0 && !w.weekdays.includes(local.weekday)) {
    return false
  }

  const parseHHMM = s => {
    if (typeof s !== 'string') return null
    const m = s.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const h = +m[1], mn = +m[2]
    if (h < 0 || h > 23 || mn < 0 || mn > 59) return null
    return h * 60 + mn
  }
  const start = parseHHMM(w.start)
  const end   = parseHHMM(w.end)
  if (start === null || end === null) return true
  if (start === end) return true
  const cur = local.hour * 60 + local.minute
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

function semverGt(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex')
}

// Vérifie le Bearer token et retourne la ligne agent_tokens, ou null.
// Filtre les tokens révoqués et les tokens dont l'expiration programmée
// (rotation) est dépassée — sans toucher revoked_at, qui reste réservé
// à la révocation explicite par admin.
async function authToken(fastify, req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  const plain = auth.slice(7)
  const hash  = hashToken(plain)
  const { rows } = await fastify.db.query(
    `SELECT * FROM agent_tokens
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
    [hash]
  )
  return rows[0] || null
}


export default async function agentRoute(fastify) {

  // Certains anciens clients envoient un Content-Length basé sur les caractères
  // Unicode alors que le body est encodé en UTF-8 — on supprime le header
  // pour éviter le rejet en 400.
  fastify.addHook('preParsing', async (req, reply, payload) => {
    delete req.headers['content-length']
    return payload
  })

  // POST /api/agent/exchange-token — échange un bootstrap token contre un
  // token perso device-lié. Pattern setup-key Tailscale/Netbird :
  //   - Le bootstrap est embarqué dans un script Intune unique poussé à N PCs.
  //   - Au runtime, chaque PC appelle ce endpoint avec son hostname/serial.
  //   - On crée (ou retrouve) le device, on génère un token perso, on le retourne.
  //   - Le bootstrap reste valide pour d'autres exchanges jusqu'à expires_at.
  // Body  : { hostname (req), serial? }
  // Reply : { token, device_id, hostname }
  fastify.post('/exchange-token', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const auth = req.headers.authorization || ''
    if (!auth.startsWith('Bearer ')) return reply.code(401).send({ error: 'Bootstrap token manquant' })

    const plain = auth.slice(7)
    const hash  = hashToken(plain)
    const hostname = String(req.body?.hostname || '').trim()
    const serial   = String(req.body?.serial   || '').trim() || null
    if (!hostname) return reply.code(400).send({ error: 'hostname requis' })

    // Transaction + SELECT FOR UPDATE pour sérialiser les exchanges concurrents
    // du même bootstrap. Sans ça, deux exchanges simultanés pouvaient passer
    // le check de quota et dépasser bootstrap_max_redeems.
    const client = await fastify.db.connect()
    let result
    try {
      await client.query('BEGIN')

      const { rows: bs } = await client.query(
        `SELECT id, label FROM agent_tokens
           WHERE token_hash = $1
             AND is_bootstrap = TRUE
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
             AND (bootstrap_max_redeems IS NULL
                  OR bootstrap_redeemed_count < bootstrap_max_redeems)
           FOR UPDATE`,
        [hash]
      )
      if (!bs[0]) {
        await client.query('ROLLBACK')
        return reply.code(401).send({ error: 'Bootstrap invalide, expiré, révoqué ou quota atteint' })
      }

      // Trouver ou créer le device par hostname
      let deviceId
      const { rows: dev } = await client.query(
        'SELECT id FROM devices WHERE hostname = $1', [hostname]
      )
      if (dev[0]) {
        deviceId = dev[0].id
      } else {
        const { rows: nd } = await client.query(
          `INSERT INTO devices (hostname, serial, source, last_seen)
           VALUES ($1, $2, 'agent', now())
           RETURNING id`,
          [hostname, serial]
        )
        deviceId = nd[0].id
      }

      // Token perso (sans expiration — survit à la révocation du bootstrap)
      const newToken = crypto.randomBytes(32).toString('hex')
      const newHash  = hashToken(newToken)
      const label    = `auto-${hostname}-${new Date().toISOString().slice(0, 10)}`

      await client.query(
        `INSERT INTO agent_tokens (label, token_hash, device_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [label, newHash, deviceId, `bootstrap:${bs[0].label}`]
      )

      await client.query(
        `UPDATE agent_tokens
           SET bootstrap_redeemed_count = bootstrap_redeemed_count + 1,
               bootstrap_redeemed_at    = now()
           WHERE id = $1`,
        [bs[0].id]
      )

      await client.query('COMMIT')
      result = { token: newToken, deviceId, bootstrapLabel: bs[0].label }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fastify.log.error({ err: err.message }, 'exchange-token transaction failed')
      return reply.code(500).send({ error: 'Erreur interne' })
    } finally {
      client.release()
    }

    logAudit(fastify.db, fastify.log, {
      action:  'agent_bootstrap_exchange',
      byUser:  hostname,
      target:  result.deviceId,
      details: { bootstrap_label: result.bootstrapLabel, serial },
    })

    reply.code(201).send({ token: result.token, device_id: result.deviceId, hostname })
  })

  // GET /api/agent/version — sondé par l'agent en self-test pour valider la
  // connectivité. Retourne la version courante du binaire Go (sidecar
  // agent-version.txt produit par agent-go/build.js).
  fastify.get('/version', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    reply.send({ latest_version: readGoAgentVersion() })
  })

  // GET /api/agent/runtime-config — paramètres runtime que l'agent fetche au
  // démarrage et à chaque checkin. Permet à l'admin de changer le nom du
  // compte LAPS recovery depuis l'UI Paramètres sans redéployer les agents.
  // Le défaut neutre (`opale-recovery`) est posé par la migration 038 ; les
  // instances historiques peuvent surcharger via UI ou seed.
  fastify.get('/runtime-config', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const { rows } = await fastify.db.query(
      `SELECT value FROM settings WHERE key = 'agent.laps_recovery_username'`
    )
    reply.send({
      laps_recovery_username: rows[0]?.value || 'opale-recovery',
    })
  })

  // GET /api/agent/binary/meta — métadonnées du binaire Go pour auto-update
  // Sélection arch : ?arch=amd64|arm64 explicite, sinon UA, sinon amd64.
  fastify.get('/binary/meta', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const arch = req.query?.arch || archFromUA(req.headers['user-agent'])
    const meta = getAgentBinaryMeta(arch)
    if (!meta)         return reply.code(404).send({ error: `Binaire agent introuvable pour arch=${arch}` })
    if (meta.error)    return reply.code(503).send({ error: meta.error })

    reply.send({
      arch:              meta.arch,
      version:           meta.version,
      sha256:            meta.sha256,
      signature_ed25519: meta.signature,
      size:              meta.size
    })
  })

  // GET /api/agent/binary — binaire Go signé. La signature est exposée en
  // header pour que l'agent puisse vérifier sans seconde requête.
  fastify.get('/binary', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const arch = req.query?.arch || archFromUA(req.headers['user-agent'])
    const meta = getAgentBinaryMeta(arch)
    if (!meta)        return reply.code(404).send({ error: `Binaire agent introuvable pour arch=${arch}` })
    if (meta.error)   return reply.code(503).send({ error: meta.error })

    reply
      .header('Content-Type',                 'application/octet-stream')
      .header('Content-Disposition',          `attachment; filename="${meta.filename}"`)
      .header('Content-Length',               meta.size)
      .header('X-Agent-Version',              meta.version)
      .header('X-Agent-Arch',                 meta.arch)
      .header('X-Agent-SHA256',               meta.sha256)
      .header('X-Agent-Signature-Ed25519',    meta.signature)
      .send(meta.body)
  })

  // POST /api/agent/rotate-token — l'agent demande un nouveau token, l'ancien
  // expire dans 24h (grace pour les checkins en vol). Atomique en transaction.
  fastify.post('/rotate-token', async (req, reply) => {
    const t = await authToken(fastify, req)
    if (!t) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const newToken   = crypto.randomBytes(32).toString('hex')
    const newHash    = hashToken(newToken)
    const graceMs    = 24 * 60 * 60 * 1000
    const expiresAt  = new Date(Date.now() + graceMs)

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const ins = await client.query(`
        INSERT INTO agent_tokens (device_id, token_hash, label, created_by)
        VALUES ($1, $2, $3, 'agent-rotation')
        RETURNING id
      `, [t.device_id, newHash, (t.label || 'agent') + ' (rotated)'])
      const newId = ins.rows[0].id

      await client.query(`
        UPDATE agent_tokens SET expires_at = $1, replaced_by = $2 WHERE id = $3
      `, [expiresAt, newId, t.id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    await logAudit(fastify.db, fastify.log, {
      action:  'token_rotated',
      byUser:  'agent',
      target:  t.device_id,
      details: { old_token_id: t.id, expires_at: expiresAt.toISOString() },
    })

    reply.send({ token: newToken, expires_at_old: expiresAt.toISOString() })
  })

  // POST /api/agent/admin-credential — escrow du mdp admin local rotaté.
  // L'agent envoie le password chiffré RSA-OAEP avec laps.pub embarqué.
  // Le serveur stocke tel quel ; la décryption ne se fait qu'à la demande
  // (admin-auth) via /api/devices/:id/admin-credential.
  fastify.post('/admin-credential', {
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const t = await authToken(fastify, req)
    if (!t) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const { username, encrypted_password } = req.body || {}
    if (!username || !encrypted_password) {
      return reply.code(400).send({ error: 'username et encrypted_password requis' })
    }
    if (typeof encrypted_password !== 'string' || encrypted_password.length > 5000) {
      return reply.code(400).send({ error: 'encrypted_password invalide' })
    }

    const buf = Buffer.from(encrypted_password, 'base64')
    if (buf.length < 200 || buf.length > 1024) {
      // RSA-2048 OAEP-SHA256 = 256 octets. On reste large pour 3072/4096.
      return reply.code(400).send({ error: 'taille du ciphertext suspecte' })
    }
    if (!t.device_id) {
      return reply.code(400).send({ error: 'token sans device_id' })
    }

    await fastify.db.query(`
      INSERT INTO device_admin_credentials
        (device_id, username, encrypted_password, password_changed_at, rotation_requested_at)
      VALUES ($1, $2, $3, now(), NULL)
      ON CONFLICT (device_id) DO UPDATE SET
        username              = EXCLUDED.username,
        encrypted_password    = EXCLUDED.encrypted_password,
        password_changed_at   = now(),
        rotation_requested_at = NULL
    `, [t.device_id, username, buf])

    await logAudit(fastify.db, fastify.log, {
      action:  'laps_rotated',
      byUser:  'agent',
      target:  t.device_id,
      details: { username },
    })

    reply.code(204).send()
  })

  // POST /api/agent/result — résultat d'exécution de script par l'agent
  fastify.post('/result', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })
    // Un token sans device_id ne peut pas remonter de résultat d'exécution :
    // il n'est rattaché à aucune machine, donc aucun script n'aurait pu lui
    // être assigné. Empêche aussi un bootstrap utilisé hors flow exchange.
    if (!token.device_id) return reply.code(403).send({ error: 'Token sans device_id' })

    const { execution_id, exit_code, output } = req.body || {}
    if (!execution_id) return reply.code(400).send({ error: 'execution_id requis' })

    const status = exit_code === 0 ? 'done' : 'error'
    // Le filtre device_id = token.device_id empêche un agent compromis de
    // remonter de faux résultats pour les exécutions d'autres devices
    // (cross-device tampering).
    const updated = await fastify.db.query(`
      UPDATE script_executions
      SET status = $1, exit_code = $2, output = $3, completed_at = now()
      WHERE id = $4 AND mode = 'agent' AND device_id = $5
      RETURNING device_id, script_name
    `, [status, exit_code ?? -1, (output || '').slice(0, 100000), execution_id, token.device_id])

    // Audit log (uniquement en cas de succès, pour valoriser dans Rapports)
    if (status === 'done' && updated.rows[0]) {
      await logAudit(fastify.db, fastify.log, {
        action:  'script_executed_remote',
        byUser:  'agent',
        target:  updated.rows[0].device_id,
        details: { script: updated.rows[0].script_name || null },
      })
    }

    reply.code(204).send()
  })

  // POST /api/agent/setup-log — logs des scripts Intune (openssh, agent install…)
  // Pas d'auth : tourne en SYSTEM avant tout enrôlement. Rate-limit large pour
  // ne pas pénaliser un déploiement de masse Intune.
  fastify.post('/setup-log', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const { hostname, script, level = 'info', log } = req.body || {}
    if (!hostname || !log) return reply.code(400).send({ error: 'hostname et log requis' })

    // Ignorer les logs de checkin de routine (agents anciens qui loggent chaque run)
    if (script === 'checkin' && (!level || level === 'info')) {
      return reply.code(204).send()
    }

    await logAudit(fastify.db, fastify.log, {
      action:  'setup_script',
      byUser:  hostname,
      target:  script || 'unknown',
      details: { level, log },
    })
    fastify.log.info({ hostname, script, level }, 'setup-log reçu')
    reply.code(204).send()
  })

  // POST /api/agent/checkin — checkin périodique de l'agent
  fastify.post('/checkin', async (req, reply) => {
    const token = await authToken(fastify, req)
    if (!token) return reply.code(401).send({ error: 'Token invalide ou révoqué' })

    const {
      hostname, serial, os, os_build, ram_gb,
      ip_netbird, disks: _disks, network: _network, bandwidth: _bw, ping: _ping,
      agent_version,
      deployment_results: _depResults,
      detection_results:  _detResults,
      health,
      tamper,
      system_info,
      system_perf,
    } = req.body || {}

    // PowerShell 5 serialise les tableaux vides en null — normaliser ici
    const disks              = Array.isArray(_disks)      ? _disks      : []
    const network            = Array.isArray(_network)    ? _network    : []
    const bandwidth          = Array.isArray(_bw)         ? _bw         : []
    const ping               = Array.isArray(_ping)       ? _ping       : []
    const deployment_results = Array.isArray(_depResults) ? _depResults : []
    const detection_results  = Array.isArray(_detResults) ? _detResults : []

    if (!hostname) return reply.code(400).send({ error: 'hostname requis' })

    // ── Thresholds + fenêtre de maintenance ───────────────────────────────
    const { rows: settingRows } = await fastify.db.query(
      `SELECT key, value FROM settings WHERE key IN ('disk_warn_pct','disk_critical_pct','maintenance_window_default')`
    )
    const settingMap = Object.fromEntries(settingRows.map(r => [r.key, r.value]))
    const diskWarn = parseInt(settingMap.disk_warn_pct     ?? '80', 10)
    const diskCrit = parseInt(settingMap.disk_critical_pct ?? '90', 10)

    let maintenanceWindow = null
    if (settingMap.maintenance_window_default) {
      try {
        maintenanceWindow = JSON.parse(settingMap.maintenance_window_default)
      } catch (err) {
        fastify.log.warn({ err: err.message }, 'maintenance_window_default JSON invalide')
      }
    }
    const inMaintWindow = isMaintenanceWindowActive(maintenanceWindow, new Date())

    // ── Upsert device ───────────────────────────────────────────────────────
    // compliance_state lu ici pour le passer à l'évaluateur de conformité plus
    // bas (évite une seconde requête). Vient de la sync Intune, jamais du
    // checkin, donc safe à lire avant l'UPDATE.
    //
    // Stratégie de lookup :
    //   1. Lookup par serial (si fourni) — match prioritaire
    //   2. Fallback hostname si le 1) retourne 0 row
    //
    // Le fallback est nécessaire pour le cas observé en prod (RESTCHIREAU,
    // 2026-05-10/12) : un device créé par sync Intune sans serial agent
    // (Intune n'a pas forcément accès au BIOS serial), puis l'agent
    // checkin avec son serial — lookup-par-serial → 0 row → branche INSERT
    // → fail unique constraint sur hostname. Avec le fallback, on tombe
    // sur la row Intune et on l'UPDATE normalement.
    let lookup = serial
      ? await fastify.db.query(`SELECT id, source, disk_used_pct, compliance_state FROM devices WHERE serial = $1`, [serial])
      : await fastify.db.query(`SELECT id, source, disk_used_pct, compliance_state FROM devices WHERE hostname = $1`, [hostname])
    if (serial && !lookup.rows.length) {
      lookup = await fastify.db.query(
        `SELECT id, source, disk_used_pct, compliance_state FROM devices WHERE hostname = $1`,
        [hostname]
      )
    }

    // Anti cross-device : un token déjà rattaché à un device ne peut pas
    // poster un checkin pour un autre device (hostname/serial spoofé dans
    // le payload). On rejette avant toute mutation pour éviter de polluer
    // l'état du device d'origine.
    if (token.device_id && lookup.rows[0] && lookup.rows[0].id !== token.device_id) {
      return reply.code(403).send({ error: 'Token lié à un autre device' })
    }

    const mainDisk = disks.find(d => d.letter === 'C:') || disks[0]

    const healthJSON = health && typeof health === 'object' ? JSON.stringify(health) : null
    const sysInfoJSON = system_info && typeof system_info === 'object' ? JSON.stringify(system_info) : null

    let deviceId
    if (lookup.rows.length) {
      deviceId = lookup.rows[0].id
      await fastify.db.query(`
        UPDATE devices SET
          hostname          = $1,
          os                = COALESCE($2, os),
          os_build          = COALESCE($3, os_build),
          ram_gb            = COALESCE($4, ram_gb),
          disk_used_pct     = COALESCE($5, disk_used_pct),
          disk_total_gb     = COALESCE($6, disk_total_gb),
          ip_netbird        = COALESCE($7, ip_netbird),
          agent_version     = COALESCE($8, agent_version),
          health_signals    = COALESCE($10::jsonb, health_signals),
          health_updated_at = CASE WHEN $10::jsonb IS NOT NULL THEN now() ELSE health_updated_at END,
          system_info       = COALESCE($11::jsonb, system_info),
          last_seen         = now(),
          updated_at        = now()
        WHERE id = $9
      `, [
        hostname,
        os            || null,
        os_build      || null,
        ram_gb        || null,
        mainDisk?.used_pct  ?? null,
        mainDisk?.size_gb   ?? null,
        ip_netbird    || null,
        agent_version || null,
        deviceId,
        healthJSON,
        sysInfoJSON,
      ])
    } else {
      const res = await fastify.db.query(`
        INSERT INTO devices (
          hostname, serial, os, os_build, ram_gb,
          disk_used_pct, disk_total_gb, ip_netbird,
          agent_version, health_signals,
          health_updated_at, system_info,
          source, last_seen, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
          CASE WHEN $10::jsonb IS NOT NULL THEN now() ELSE NULL END,
          $11::jsonb,
          'agent',now(),now())
        RETURNING id
      `, [
        hostname,
        serial        || null,
        os            || null,
        os_build      || null,
        ram_gb        || null,
        mainDisk?.used_pct ?? null,
        mainDisk?.size_gb  ?? null,
        ip_netbird    || null,
        agent_version || null,
        healthJSON,
        sysInfoJSON,
      ])
      deviceId = res.rows[0].id
    }

    // ── Upsert partitions ───────────────────────────────────────────────────
    for (const disk of disks) {
      if (!disk.letter) continue
      await fastify.db.query(`
        INSERT INTO disks (device_id, letter, label, size_gb, used_pct, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (device_id, letter) DO UPDATE SET
          label      = COALESCE(EXCLUDED.label, disks.label),
          size_gb    = EXCLUDED.size_gb,
          used_pct   = EXCLUDED.used_pct,
          updated_at = now()
      `, [deviceId, disk.letter, disk.label || null, disk.size_gb || null, disk.used_pct ?? null])
    }

    // ── Interfaces réseau (refresh complet) ────────────────────────────────
    if (network.length > 0) {
      await fastify.db.query(`DELETE FROM network_interfaces WHERE device_id = $1`, [deviceId])
      for (const iface of network) {
        if (!iface.mac) continue
        await fastify.db.query(`
          INSERT INTO network_interfaces (device_id, mac, ip, adapter, type)
          VALUES ($1, $2, $3, $4, $5)
        `, [deviceId, iface.mac, iface.ip || null, iface.adapter || null, iface.type || 'eth'])
      }
    }

    // ── Bande passante ──────────────────────────────────────────────────────
    for (const bw of bandwidth) {
      if (!bw.adapter) continue
      await fastify.db.query(`
        INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv)
        VALUES ($1, $2, $3, $4)
      `, [deviceId, bw.adapter, bw.bytes_sent ?? null, bw.bytes_recv ?? null])
    }
    // Nettoyage des samples > 7 jours (non-bloquant)
    fastify.db.query(`DELETE FROM bandwidth_stats WHERE device_id = $1 AND sampled_at < now() - interval '7 days'`, [deviceId]).catch(() => {})

    // ── Ping stats ──────────────────────────────────────────────────────────
    const pings = Array.isArray(ping) ? ping : (ping ? [ping] : [])
    for (const p of pings) {
      if (!p?.host) continue
      await fastify.db.query(`
        INSERT INTO ping_stats (device_id, host, latency_ms, packet_loss_pct)
        VALUES ($1, $2, $3, $4)
      `, [deviceId, p.host, p.latency_ms ?? null, p.packet_loss_pct ?? null])
    }
    if (pings.length) {
      fastify.db.query(`DELETE FROM ping_stats WHERE device_id = $1 AND sampled_at < now() - interval '7 days'`, [deviceId]).catch(() => {})
    }

    // ── System perf (RAM/CPU/uptime/batterie) ──────────────────────────────
    if (system_perf && typeof system_perf === 'object') {
      const sp = system_perf
      await fastify.db.query(`
        INSERT INTO system_perf_stats (
          device_id, ram_used_gb, ram_total_gb, ram_used_pct,
          cpu_avg_pct, cpu_max_pct, uptime_seconds,
          battery_pct, battery_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        deviceId,
        sp.ram_used_gb    ?? null,
        sp.ram_total_gb   ?? null,
        sp.ram_used_pct   ?? null,
        sp.cpu_avg_pct    ?? null,
        sp.cpu_max_pct    ?? null,
        sp.uptime_seconds ?? null,
        sp.battery_pct    ?? null,
        sp.battery_status ?? null,
      ])
      // Cleanup non-bloquant
      fastify.db.query(
        `DELETE FROM system_perf_stats WHERE device_id = $1 AND sampled_at < now() - interval '7 days'`,
        [deviceId]
      ).catch(() => {})
    }

    // ── Évaluation conformité ──────────────────────────────────────────────
    // Set fixe de règles built-in (cf. api/lib/compliance.js). Évalué à chaque
    // checkin : transaction déjà ouverte, data fraîche, pas de batch
    // périodique à orchestrer. Best-effort : un problème ici (DB, règle
    // bugguée) ne doit jamais faire échouer le checkin — un agent qui ne
    // checkin plus est bien plus grave qu'une éval ratée.
    try {
      await evaluateCompliance(fastify, deviceId, {
        hostname,                                                  // pour le titre des ticket_proposals + push
        health:               health || null,
        system_info:          system_info || null,
        last_seen:            new Date(),                          // qu'on vient de set à now() dans l'UPDATE devices
        agent_version:        agent_version || null,
        latest_agent_version: readGoAgentVersion(),                // sidecar dist/agent-version.txt
        compliance_state:     lookup.rows[0]?.compliance_state ?? null,
        disk_c_used_pct:      mainDisk?.used_pct ?? null,
      })
    } catch (err) {
      fastify.log.warn({ err: err.message, deviceId }, 'compliance evaluation failed (checkin continues)')
    }

    // ── Résultats des déploiements exécutés par l'agent ────────────────────
    for (const r of deployment_results) {
      if (!r.deployment_id) continue
      try {
        const upd = await fastify.db.query(`
          UPDATE deployments SET
            status       = CASE WHEN $1 = 0 THEN 'success' ELSE 'failed' END,
            exit_code    = $1,
            output       = $2,
            completed_at = now()
          WHERE id = $3 AND device_id = $4 AND status = 'running'
          RETURNING package_id, status
        `, [r.exit_code ?? -1, r.output || null, r.deployment_id, deviceId])

        // Audit log (uniquement les déploiements réussis, pour valoriser dans Rapports)
        if (upd.rows[0]?.status === 'success') {
          logAudit(fastify.db, fastify.log, {
            action:  'package_deployed',
            byUser:  'agent',
            target:  deviceId,
            details: { package_id: upd.rows[0].package_id, deployment_id: r.deployment_id },
          })
        }
      } catch (err) {
        fastify.log.warn({ err: err.message, deployment_id: r.deployment_id }, 'deployment result update failed')
      }
    }

    // ── Résultats des scripts de détection ─────────────────────────────────
    for (const r of detection_results) {
      if (!r.package_id) continue
      try {
        await fastify.db.query(`
          INSERT INTO device_software (device_id, package_id, detected, checked_at)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (device_id, package_id) DO UPDATE SET
            detected   = EXCLUDED.detected,
            checked_at = now()
        `, [deviceId, r.package_id, r.detected ?? false])
      } catch (err) {
        fastify.log.warn({ err: err.message, package_id: r.package_id }, 'detection result update failed')
      }
    }

    // ── Tamper detection : binaire altéré côté agent ───────────────────────
    // Audit + push immédiate. Ne bloque PAS le checkin (l'agent peut être
    // legit avec un state.json corrompu — admin investigue manuellement).
    if (tamper && tamper.expected && tamper.actual && tamper.expected !== tamper.actual) {
      try {
        await logAudit(fastify.db, fastify.log, {
          action:  'tamper_detected',
          byUser:  hostname,
          target:  deviceId,
          details: tamper,
        })
        sendPushToAll(fastify, {
          title:    `⚠ Tamper ${hostname}`,
          body:     `Hash binaire altéré (${tamper.actual.slice(0,8)}… ≠ ${tamper.expected.slice(0,8)}…)`,
          deviceId,
          url:      `/mobile.html#/poste/${deviceId}`,
        }).catch(err => fastify.log.warn({ err: err.message }, 'tamper push failed'))
      } catch (err) {
        fastify.log.warn({ err: err.message }, 'tamper audit log failed')
      }
    }

    // ── Mettre à jour le token (last_used_at + device_id) ──────────────────
    await fastify.db.query(`
      UPDATE agent_tokens SET last_used_at = now(), device_id = $1 WHERE id = $2
    `, [deviceId, token.id])

    // ── Commandes script en attente (mode agent) ───────────────────────────
    const pendingScripts = await fastify.db.query(`
      SELECT id, script_name, script_content
      FROM script_executions
      WHERE device_id = $1 AND status = 'pending' AND mode = 'agent'
      ORDER BY queued_at ASC LIMIT 5
    `, [deviceId])

    if (pendingScripts.rows.length) {
      await fastify.db.query(`
        UPDATE script_executions SET status = 'running', started_at = now()
        WHERE id = ANY($1::uuid[])
      `, [pendingScripts.rows.map(r => r.id)])
    }

    // ── Fan-out deployment_jobs → deployments pour ce device ──────────────
    // Crée les execution rows manquantes pour les jobs scope=group|all|user
    // applicables à ce device :
    //   - all  : tout device managé
    //   - group: device membre du groupe (cf. device_group_memberships)
    //   - user : device dont assigned_user_id matche le user du job (réassign
    //            d'un user à un nouveau PC redéclenche ses packages)
    await fastify.db.query(`
      INSERT INTO deployments (package_id, device_id, deployed_by, job_id)
      SELECT j.package_id, $1, j.deployed_by, j.id
      FROM deployment_jobs j
      WHERE j.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM deployments d WHERE d.job_id = j.id AND d.device_id = $1
        )
        AND (
          j.scope = 'all'
          OR (j.scope = 'group' AND j.source_group_id IN (
            SELECT group_id FROM device_group_memberships WHERE device_id = $1
          ))
          OR (j.scope = 'user' AND j.user_entra_id = (
            SELECT assigned_user_id FROM devices WHERE id = $1
          ))
          OR (j.scope = 'native_group' AND j.native_group_id IN (
            SELECT group_id FROM group_members WHERE device_id = $1
          ))
        )
      ON CONFLICT DO NOTHING
    `, [deviceId])

    // ── Déploiements de packages en attente ────────────────────────────────
    // Gated par la fenêtre de maintenance : hors fenêtre, on n'envoie
    // pas les deployments pour éviter de les passer en 'running' alors
    // que l'agent n'aurait pas le droit de les exécuter.
    const pendingDeployments = inMaintWindow ? await fastify.db.query(`
      SELECT d.id AS deployment_id, p.type, p.winget_id, p.install_script, p.post_install_script, p.detection_script, p.name
      FROM deployments d
      JOIN packages p ON p.id = d.package_id
      WHERE d.device_id = $1 AND d.status = 'pending'
      ORDER BY d.queued_at ASC LIMIT 10
    `, [deviceId]) : { rows: [] }

    if (pendingDeployments.rows.length) {
      await fastify.db.query(`
        UPDATE deployments SET status = 'running', started_at = now()
        WHERE id = ANY($1::uuid[])
      `, [pendingDeployments.rows.map(r => r.deployment_id)])
    }

    // ── Packages à détecter (approuvés, pas détectés depuis 24h) ──────────
    const toDetect = await fastify.db.query(`
      SELECT p.id AS package_id, p.detection_script
      FROM packages p
      WHERE p.status = 'approved' AND p.detection_script IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM device_software s
          WHERE s.device_id = $1 AND s.package_id = p.id
            AND s.checked_at > now() - INTERVAL '24h'
        )
      LIMIT 20
    `, [deviceId])

    // ── Mise à jour disponible ? ────────────────────────────────────────────
    // Détection des agents Go acceptés. Tout client hors-Go est ignoré.
    // Une instance qui hérite d'agents builds avec un slug User-Agent
    // historique peut ajouter ce slug via OPALE_LEGACY_AGENT_UA_PATTERN
    // (regex, ex: 'old-agent-go') — c'est OR-é au pattern Opale standard.
    const ua = req.headers['user-agent'] || ''
    const legacyUa = (process.env.OPALE_LEGACY_AGENT_UA_PATTERN || '').trim()
    const isGoAgent = /opale-agent(-go)?/.test(ua) || (legacyUa && new RegExp(legacyUa).test(ua))

    let agentUpdate = null
    if (inMaintWindow && isGoAgent) {
      const arch = archFromUA(ua)
      const meta = getAgentBinaryMeta(arch)
      if (meta && !meta.error && meta.version && meta.signature
          && agent_version && semverGt(meta.version, agent_version)) {
        agentUpdate = {
          latest_version:    meta.version,
          download_url:      `/api/agent/binary?arch=${arch}`,
          sha256:            meta.sha256,
          signature_ed25519: meta.signature,
        }
      }
    }

    // ── Push notification si transition disque vers critique/warn ──────────
    const prevPct = lookup.rows[0]?.disk_used_pct ?? null
    const newPct  = mainDisk?.used_pct ?? null
    if (newPct !== null) {
      const wasOK  = prevPct === null || prevPct < diskWarn
      const isCrit = newPct >= diskCrit
      const isWarn = newPct >= diskWarn
      if (wasOK && (isCrit || isWarn)) {
        sendPushToAll(fastify, {
          title:    `⚠ ${hostname}`,
          body:     `Disque C: ${newPct}% ${isCrit ? '— critique' : '— alerte'}`,
          deviceId,
          url:      `/mobile.html#/poste/${deviceId}`
        }).catch(err => fastify.log.warn({ err: err.message }, 'push failed (non-bloquant)'))
      }
    }

    // ── Log checkin non-bloquant ───────────────────────────────────────────
    await logAudit(fastify.db, fastify.log, {
      action:  'agent_checkin',
      byUser:  hostname,
      target:  deviceId,
      details: { level: 'info', disks: disks.length, ip_netbird: ip_netbird || null, new: !lookup.rows.length, agent_version: agent_version || null },
    })

    reply.send({
      ok:         true,
      device_id:  deviceId,
      new:        !lookup.rows.length,
      commands:   pendingScripts.rows.map(r => ({ id: r.id, name: r.script_name, script: r.script_content })),
      deployments: pendingDeployments.rows.map(r => ({
        deployment_id:       r.deployment_id,
        name:                r.name,
        type:                r.type,
        winget_id:           r.winget_id,
        install_script:      r.install_script,
        post_install_script: r.post_install_script,
        detection_script:    r.detection_script,
      })),
      detect: toDetect.rows.map(r => ({
        package_id:       r.package_id,
        detection_script: r.detection_script,
      })),
      agent_update:        agentUpdate,
      maintenance_window:  maintenanceWindow,
    })
  })

  // ── WebSocket persistant agent ↔ serveur ─────────────────────────────────
  // Canal de contrôle long-lived qui complète le polling 15min. Sert :
  //   - en PR 1 : heartbeat + advertise capabilities (rien d'observable côté
  //     utilisateur, juste le tube qui se monte) ;
  //   - en PR 2 : à porter la console interactive (frames console.*).
  //
  // Auth : Bearer dans le header HTTP Upgrade (PAS de query string — c'est
  // l'agent Go qui se connecte, pas un browser, donc aucun risque de fuite
  // via Referer / cache / logs reverse-proxy, et un header est intercepté
  // par bien moins d'intermédiaires).
  //
  // Une seule connexion active par device (cf. AgentWSRegistry.register).
  const HEARTBEAT_INTERVAL_MS = 30_000
  const HEARTBEAT_TIMEOUT_MS  = 45_000

  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const token = await authToken(fastify, req)
    if (!token || !token.device_id) {
      try { socket.close(WS_CLOSE.AUTH_FAIL, 'auth') } catch {}
      return
    }

    // Hostname pour l'audit + push. Le device peut avoir été supprimé entre
    // l'auth du token et le connect ; dans ce cas on refuse aussi.
    const { rows: devRows } = await fastify.db.query(
      'SELECT hostname FROM devices WHERE id = $1', [token.device_id]
    )
    if (!devRows[0]) {
      try { socket.close(WS_CLOSE.AUTH_FAIL, 'device-missing') } catch {}
      return
    }
    const hostname = devRows[0].hostname

    const conn = makeAgentConn(socket, {
      deviceId: token.device_id,
      tokenId:  token.id,
      hostname,
    })
    fastify.agentWs.register(token.device_id, conn)

    // Audit + last_seen_ws au connect. Best-effort, ne bloque pas la session.
    fastify.db.query(
      `UPDATE devices SET last_seen_ws = now() WHERE id = $1`,
      [token.device_id]
    ).catch(err => fastify.log.warn({ err: err.message }, 'last_seen_ws update failed'))
    logAudit(fastify.db, fastify.log, {
      action:  'agent_ws_connect',
      byUser:  hostname,
      target:  token.device_id,
      details: { token_id: token.id },
    })

    conn.send('welcome', {
      server_time:        new Date().toISOString(),
      ping_interval_s:    HEARTBEAT_INTERVAL_MS / 1000,
      heartbeat_timeout_s: HEARTBEAT_TIMEOUT_MS / 1000,
    })

    // Heartbeat : ping périodique + close si pong manquant. Le timer est
    // détruit dans le handler onClose.
    const heartbeat = setInterval(() => {
      const sincePong = Date.now() - conn.lastPongAt
      if (sincePong > HEARTBEAT_TIMEOUT_MS) {
        fastify.log.info({ device_id: token.device_id, since_pong_ms: sincePong }, 'agent ws heartbeat timeout')
        conn.close(WS_CLOSE.HEARTBEAT, 'heartbeat-timeout')
        return
      }
      conn.send('ping', { ts: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)

    socket.on('message', (raw) => {
      // Garde-fou taille avant parsing JSON pour éviter qu'un agent
      // compromis n'épuise la mémoire avec une frame géante.
      if (raw.length > WS_FRAME_MAX_BYTES) {
        conn.close(WS_CLOSE.PROTOCOL, 'frame-too-large')
        return
      }
      let msg
      try { msg = JSON.parse(raw.toString()) }
      catch {
        conn.close(WS_CLOSE.PROTOCOL, 'invalid-json')
        return
      }
      if (!msg || typeof msg.type !== 'string') {
        conn.close(WS_CLOSE.PROTOCOL, 'invalid-frame')
        return
      }

      switch (msg.type) {
        case 'hello': {
          // L'agent déclare sa version + capabilities après le welcome.
          // On stocke pour que /api/console/grant (PR 2) puisse refuser
          // proprement les agents sans capability "console".
          const d = msg.data || {}
          conn.agentVersion = typeof d.agent_version === 'string' ? d.agent_version : null
          conn.os           = typeof d.os   === 'string' ? d.os   : null
          conn.arch         = typeof d.arch === 'string' ? d.arch : null
          conn.capabilities = Array.isArray(d.capabilities)
            ? d.capabilities.filter(c => typeof c === 'string').slice(0, 32)
            : []
          break
        }
        case 'pong':
          conn.lastPongAt = Date.now()
          break
        case 'ping':
          // L'agent ne pinge pas (c'est le serveur qui mène le heartbeat),
          // mais on répond proprement si jamais ça arrive — pas une raison de close.
          conn.send('pong', { ts: Date.now() })
          break
        case 'bye':
          conn.close(1000, 'client-bye')
          break

        // ── Frames console.* (PR 2) ──────────────────────────────────────
        // L'agent envoie des frames console.* avec un session_id qu'on
        // mappe à la session enregistrée dans consoleSessions (la WS
        // browser). Si la session a déjà été fermée côté serveur, on
        // ignore — l'agent recevra console.close au prochain cycle.
        case 'console.opened': {
          const sess = fastify.consoleSessions.get(msg.id)
          if (!sess) {
            conn.send('console.close', { reason: 'no-such-session' }, msg.id)
            break
          }
          sess.sendBrowser('opened', msg.data || {})
          break
        }
        case 'console.data': {
          const sess = fastify.consoleSessions.get(msg.id)
          if (!sess) break
          // Capture la sortie terminal en 'out' avant de la pousser au
          // browser. Décodage base64 → bytes bruts pour le buffer.
          if (sess.buffer && typeof msg.data?.b64 === 'string') {
            try { sess.buffer.add('out', Buffer.from(msg.data.b64, 'base64')) } catch {}
          }
          sess.sendBrowser('data', msg.data || {})
          break
        }
        case 'console.error': {
          const sess = fastify.consoleSessions.get(msg.id)
          if (!sess) break
          sess.sendBrowser('error', msg.data || {})
          fastify.consoleSessions.close(msg.id, 'agent-error').catch(() => {})
          break
        }
        case 'console.exit': {
          const sess = fastify.consoleSessions.get(msg.id)
          if (!sess) break
          sess.sendBrowser('exit', msg.data || {})
          const reason = (msg.data && typeof msg.data.reason === 'string') ? msg.data.reason : 'exit'
          fastify.consoleSessions.close(msg.id, reason).catch(() => {})
          break
        }

        default:
          // Type inconnu : on ignore silencieusement plutôt que de couper.
          // Les agents 2.13.0 peuvent recevoir des frames d'une version
          // serveur plus récente sans connaître leur type — robustesse forward.
          break
      }
    })

    const onClose = (code) => {
      clearInterval(heartbeat)
      fastify.agentWs.unregister(token.device_id, conn)
      fastify.db.query(
        `UPDATE devices SET last_seen_ws = now() WHERE id = $1`,
        [token.device_id]
      ).catch(() => {})

      // Cas supersede : l'audit a déjà été émis par le listener dans
      // plugins/agent-ws.js avant le close envoyé au peer. On évite la
      // double-insertion ici.
      if (conn.auditDisconnectEmitted) return

      const durationSeconds = Math.round((Date.now() - conn.connectedAt) / 1000)
      logAudit(fastify.db, fastify.log, {
        action:  'agent_ws_disconnect',
        byUser:  hostname,
        target:  token.device_id,
        details: { code, reason: wsReasonFromCode(code), duration_seconds: durationSeconds, token_id: token.id },
      })
    }

    socket.on('close', onClose)
    socket.on('error', (err) => {
      fastify.log.warn({ err: err.message, device_id: token.device_id }, 'agent ws error')
    })
  })
}
