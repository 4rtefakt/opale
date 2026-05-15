import { syncIntuneDevice } from '../../core/lib/graph.js'
import { fetchBandwidth }   from '../../monitoring/lib/bandwidth.js'
import { logAudit } from '../../core/lib/audit.js'

async function getThresholds(fastify) {
  const res = await fastify.db.query(
    `SELECT key, value FROM settings WHERE key IN ('disk_warn_pct', 'disk_critical_pct')`
  )
  const map = Object.fromEntries(res.rows.map(r => [r.key, parseInt(r.value, 10)]))
  return {
    warn:     map.disk_warn_pct     ?? 80,
    critical: map.disk_critical_pct ?? 90,
  }
}

export default async function devicesRoute(fastify) {
  // Liste des postes
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { status, search, limit = 100, offset = 0 } = req.query
    const thr = await getThresholds(fastify)

    const conditions = []
    const params = []
    let i = 1

    if (search) {
      conditions.push(
        `(d.hostname ILIKE $${i} OR u.email ILIKE $${i} OR u.display_name ILIKE $${i} OR d.model ILIKE $${i})`
      )
      params.push(`%${search}%`)
      i++
    }

    if (status === 'online') {
      conditions.push(`d.last_seen > now() - interval '1 hour'`)
    } else if (status === 'offline') {
      conditions.push(`(d.last_seen IS NULL OR d.last_seen < now() - interval '1 hour')`)
    } else if (status === 'critical') {
      conditions.push(`d.disk_used_pct >= ${thr.critical}`)
    } else if (status === 'unassigned') {
      conditions.push(`d.assigned_user_id IS NULL`)
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const result = await fastify.db.query(
      `SELECT
         d.id, d.hostname, d.serial, d.model, d.manufacturer, d.cpu,
         d.ram_gb, d.os, d.os_build, d.disk_used_pct, d.ip_netbird,
         d.agent_version,
         d.last_seen, d.created_at, d.intune_user_display_name,
         u.entra_id  AS user_id,
         u.display_name AS user_name,
         u.email     AS user_email,
         u.job_title AS user_job_title,
         COUNT(*) OVER() AS total_count
       FROM devices d
       LEFT JOIN users_cache u ON d.assigned_user_id = u.entra_id
       ${where}
       ORDER BY
         CASE
           WHEN d.disk_used_pct >= ${thr.critical} THEN 0
           WHEN d.disk_used_pct >= ${thr.warn} THEN 1
           WHEN d.last_seen > now() - interval '1 hour' THEN 2
           ELSE 3
         END,
         d.hostname
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    )

    const total = parseInt(result.rows[0]?.total_count ?? 0)
    return {
      devices: result.rows.map(row => formatDevice(row, thr)),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      // Permet à l'UI d'afficher les seuils settings (ex: "Disque critique
      // (≥95%)") et de colorer/filtrer côté client en accord avec la même
      // logique server-side (cf. computeStatus → device.status).
      thresholds: thr,
    }
  })

  // Détail d'un poste
  fastify.get('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const thr = await getThresholds(fastify)
    const result = await fastify.db.query(
      `SELECT d.*, u.entra_id AS user_id, u.display_name AS user_name,
              u.email AS user_email, u.job_title AS user_job_title
       FROM devices d
       LEFT JOIN users_cache u ON d.assigned_user_id = u.entra_id
       WHERE d.id = $1`,
      [req.params.id]
    )
    if (!result.rows[0]) return reply.code(404).send({ error: 'Poste introuvable' })

    const d = result.rows[0]

    // Vérifier les droits admin pour données sensibles (LAPS, current_user RGPD)
    const { entraId } = fastify.getUserIdentity(req)
    const adminRes = await fastify.db.query('SELECT is_admin FROM users_cache WHERE entra_id = $1', [entraId])
    const isAdmin = adminRes.rows[0]?.is_admin ?? false

    // Filtrer current_user pour les non-admins (donnée nominative RGPD)
    const system_info = d.system_info
      ? isAdmin
        ? d.system_info
        : (({ current_user: _, ...rest }) => rest)(d.system_info)
      : null

    const [disks, nets, pingRows, bandwidth, activeAlerts, recentTickets, perfRow, perfSeriesRow, lapsRow] = await Promise.all([
      fastify.db.query('SELECT * FROM disks WHERE device_id = $1 ORDER BY letter', [d.id]),
      fastify.db.query('SELECT * FROM network_interfaces WHERE device_id = $1 ORDER BY adapter', [d.id]),
      fastify.db.query(`
        SELECT host, latency_ms, packet_loss_pct, sampled_at
        FROM ping_stats
        WHERE device_id = $1 AND sampled_at > now() - interval '7 days'
        ORDER BY sampled_at ASC
      `, [d.id]),
      // Bandwidth : helper dédié (cf. api/lib/bandwidth.js). Filtre les
      // pseudo-adapters et calcule secs_since_prev pour que le front ne
      // recalcule plus l'intervalle (cf. bug pic 9.82 Gbps 2026-05-14).
      fetchBandwidth(fastify.db, d.id),
      fastify.db.query(
        'SELECT * FROM alerts WHERE device_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC',
        [d.id]
      ),
      fastify.db.query(
        `SELECT t.*, u.display_name AS user_name, u.email AS user_email
         FROM tickets t
         LEFT JOIN users_cache u ON t.user_id = u.entra_id
         WHERE t.device_id = $1 AND t.status NOT IN ('resolved','closed')
         ORDER BY t.created_at DESC LIMIT 10`,
        [d.id]
      ),
      fastify.db.query(`
        SELECT ram_used_gb, ram_total_gb, ram_used_pct, cpu_avg_pct, cpu_max_pct,
               uptime_seconds, battery_pct, battery_status
        FROM system_perf_stats
        WHERE device_id = $1
        ORDER BY sampled_at DESC LIMIT 1
      `, [d.id]),
      fastify.db.query(`
        SELECT sampled_at, ram_used_pct, cpu_avg_pct, cpu_max_pct, battery_pct
        FROM system_perf_stats
        WHERE device_id = $1 AND sampled_at > now() - interval '24 hours'
        ORDER BY sampled_at ASC
      `, [d.id]),
      fastify.db.query(`
        SELECT c.username, c.password_changed_at, c.rotation_requested_at,
               c.last_viewed_at, uc.display_name AS last_viewed_by_name
        FROM device_admin_credentials c
        LEFT JOIN users_cache uc ON uc.entra_id = c.last_viewed_by
        WHERE c.device_id = $1
      `, [d.id])
    ])

    // ── Ping : grouper par host ────────────────────────────────────────────
    const pingByHost = {}
    for (const p of pingRows.rows) {
      if (!pingByHost[p.host]) pingByHost[p.host] = []
      pingByHost[p.host].push(p)
    }
    const pingHosts = Object.entries(pingByHost).map(([host, pts]) => {
      const sumFor = (hours) => {
        const since = Date.now() - hours * 3600000
        const slice = pts.filter(p => new Date(p.sampled_at).getTime() >= since)
        if (!slice.length) return null
        const valid = slice.filter(p => p.latency_ms !== null)
        return {
          avg_ms:   valid.length ? Math.round(valid.reduce((s, p) => s + p.latency_ms, 0) / valid.length) : null,
          max_ms:   valid.length ? Math.round(Math.max(...valid.map(p => p.latency_ms))) : null,
          loss_pct: Math.round(slice.reduce((s, p) => s + (p.packet_loss_pct || 0), 0) / slice.length)
        }
      }
      return {
        host,
        series:  pts.map(p => ({ t: p.sampled_at, ms: p.latency_ms, loss: p.packet_loss_pct })),
        summary: { '4h': sumFor(4), '24h': sumFor(24), '7d': sumFor(168) }
      }
    })

    return {
      ...formatDevice(d, thr),
      health_signals: d.health_signals || null,
      system_info,
      disks: disks.rows,
      network: nets.rows,
      bandwidth,
      ping: pingHosts,
      system_perf: perfRow.rows[0] || null,
      system_perf_series: perfSeriesRow.rows.map(r => ({
        sampled_at:   r.sampled_at,
        ram_used_pct: r.ram_used_pct != null ? parseFloat(r.ram_used_pct) : null,
        cpu_avg_pct:  r.cpu_avg_pct  != null ? parseFloat(r.cpu_avg_pct)  : null,
        cpu_max_pct:  r.cpu_max_pct  != null ? parseFloat(r.cpu_max_pct)  : null,
        battery_pct:  r.battery_pct  != null ? parseInt(r.battery_pct)    : null,
      })),
      ...(isAdmin && lapsRow.rows[0] ? { laps: lapsRow.rows[0] } : {}),
      active_alerts: activeAlerts.rows,
      tickets: recentTickets.rows
    }
  })

  // GET /:id/remote-sessions — historique des accès distants sur un poste.
  // Admin uniquement (traçabilité nominative, RGPD §4.1). Cappé à 100 pour
  // ne pas exploser le payload — un poste à vingtaine d'accès / semaine
  // tient sur 100 pendant ~5 semaines, suffisant pour l'UX "récents".
  fastify.get('/:id/remote-sessions', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT
        rs.id, rs.transport, rs.by_entra_id, rs.by_name, rs.ip, rs.shell,
        rs.started_at, rs.ended_at, rs.end_reason,
        rs.takeover_of,
        EXTRACT(EPOCH FROM (COALESCE(rs.ended_at, now()) - rs.started_at))::int AS duration_s
      FROM remote_sessions rs
      WHERE rs.device_id = $1
      ORDER BY rs.started_at DESC
      LIMIT 100
    `, [req.params.id])
    reply.send({ sessions: rows })
  })

  // DELETE /:id — suppression d'un device (admin uniquement)
  fastify.delete('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `DELETE FROM devices WHERE id = $1 RETURNING hostname`,
      [req.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Poste introuvable' })
    const { displayName } = fastify.getUserIdentity(req)
    logAudit(fastify.db, fastify.log, { action: 'device_deleted', byUser: displayName, target: rows[0].hostname })
    reply.code(204).send()
  })

  // POST /force-sync — déclenche un syncDevice Intune pour chaque appareil sélectionné
  fastify.post('/force-sync', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids requis' })

    const { rows } = await fastify.db.query(
      `SELECT id, hostname, intune_device_id FROM devices WHERE id = ANY($1::uuid[])`,
      [ids]
    )

    let ok = 0, skipped = 0
    const errors = []
    await Promise.all(rows.map(async d => {
      if (!d.intune_device_id) { skipped++; return }
      try {
        await syncIntuneDevice(d.intune_device_id)
        ok++
      } catch (err) {
        errors.push(`[${d.hostname}] ${err.message}`)
        fastify.log.warn({ err: err.message, hostname: d.hostname }, 'force-sync échoué')
      }
    }))

    if (ok > 0) {
      const { entraId, displayName } = fastify.getUserIdentity(req)
      const hostnames = rows.filter(d => d.intune_device_id).map(d => d.hostname).join(', ')
      logAudit(fastify.db, fastify.log, { action: 'intune_force_sync', byUser: displayName || entraId, target: hostnames })
    }

    reply.send({ ok, skipped, errors })
  })

  // POST /force-checkin — SSH vers chaque poste et redémarre le service Windows
  // de l'agent Go (Restart-Service déclenche un checkin immédiat au startup,
  // cf. agent-go/service_windows.go). Essaie les deux noms de service possibles
  // selon le profil de branding installé : Opale-Agent par défaut, plus
  // les noms historiques optionnellement listés dans OPALE_LEGACY_AGENT_SERVICE_NAMES
  // (CSV). Le premier qui répond à Get-Service gagne.
  fastify.post('/force-checkin', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids requis' })

    const { rows } = await fastify.db.query(
      `SELECT id, hostname, ip_netbird FROM devices WHERE id = ANY($1::uuid[])`,
      [ids]
    )

    const { Client } = await import('ssh2')
    const sshKey = (() => {
      const b64 = process.env.SSH_PRIVATE_KEY_B64
      if (!b64) throw new Error('SSH_PRIVATE_KEY_B64 non défini')
      return Buffer.from(b64, 'base64').toString('utf8')
    })()

    // Construit la liste des noms de service à essayer : 'Opale-Agent' par
    // défaut, plus les éventuels noms historiques d'une instance migrée.
    // OPALE_LEGACY_AGENT_SERVICE_NAMES : CSV de noms additionnels, filtrés
    // pour ne contenir que [A-Za-z0-9_-] (anti-injection PowerShell).
    const SAFE_NAME = /^[A-Za-z0-9_-]+$/
    const legacyNames = (process.env.OPALE_LEGACY_AGENT_SERVICE_NAMES || '')
      .split(',').map(s => s.trim()).filter(s => s && SAFE_NAME.test(s))
    const serviceNames = ['Opale-Agent', ...legacyNames]
    const nameList = serviceNames.map(n => `'${n}'`).join(',')
    // $ErrorActionPreference=Stop pour rendre Restart-Service fatal.
    // exit 1 explicite si aucun service connu n'est installé sur le poste.
    const psCmd = `powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; $s = Get-Service -Name ${nameList} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($s) { Restart-Service -Name $s.Name -Force; Write-Output ('restarted: ' + $s.Name) } else { Write-Error 'no agent service installed'; exit 1 }"`

    let ok = 0, skipped = 0
    const errors = []
    const restarted = []  // { hostname, service } — alimente audit_logs.target

    await Promise.all(rows.map(d => new Promise(resolve => {
      if (!d.ip_netbird) { skipped++; return resolve() }

      const conn = new Client()
      let done = false
      const finish = () => { if (done) return; done = true; conn.end(); resolve() }
      const timeout = setTimeout(() => { errors.push(`[${d.hostname}] timeout`); conn.destroy(); finish() }, 15000)

      conn.on('ready', () => {
        conn.exec(psCmd, (err, stream) => {
          if (err) {
            clearTimeout(timeout)
            errors.push(`[${d.hostname}] ${err.message}`)
            return finish()
          }
          let stdout = '', stderr = ''
          stream.on('data', c => { stdout += c.toString() })
          stream.stderr.on('data', c => { stderr += c.toString() })
          stream.on('close', (code) => {
            clearTimeout(timeout)
            if (code !== 0) {
              const msg = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n')[0].slice(0, 200)
              errors.push(`[${d.hostname}] ${msg}`)
              return finish()
            }
            const m = stdout.match(/restarted:\s*(\S+)/)
            restarted.push({ hostname: d.hostname, service: m ? m[1] : 'unknown' })
            ok++
            finish()
          })
        })
      }).on('error', err => {
        clearTimeout(timeout)
        errors.push(`[${d.hostname}] ${err.message}`)
        fastify.log.warn({ err: err.message, hostname: d.hostname }, 'force-checkin SSH échoué')
        finish()
      }).connect({
        host:       d.ip_netbird,
        port:       parseInt(process.env.SSH_PORT || '22', 10),
        username:   (process.env.SSH_USER || '').split('@')[0],
        privateKey: sshKey,
        readyTimeout: 8000,
      })
    })))

    if (ok > 0) {
      const { entraId, displayName } = fastify.getUserIdentity(req)
      const target = restarted.map(r => `${r.hostname} (${r.service})`).join(', ')
      logAudit(fastify.db, fastify.log, { action: 'rmm_force_checkin', byUser: displayName || entraId, target })
    }

    reply.send({ ok, skipped, errors })
  })
}

function formatDevice(r, thr = { warn: 80, critical: 90 }) {
  return {
    id: r.id,
    hostname: r.hostname,
    serial: r.serial,
    model: r.model,
    manufacturer: r.manufacturer,
    cpu: r.cpu,
    ram_gb: r.ram_gb,
    os: r.os,
    os_build: r.os_build,
    disk_used_pct: r.disk_used_pct,
    disk_total_gb: r.disk_total_gb,
    ip_netbird: r.ip_netbird,
    agent_version: r.agent_version,
    last_seen: r.last_seen,
    // last_seen_ws : dernier connect/disconnect du tube agent persistant
    // (PR console-via-agent). Permet à l'UI de différencier "agent vivant
    // sur polling 15min" de "agent réactif temps réel" pour gater le
    // bouton "Console via agent".
    last_seen_ws: r.last_seen_ws,
    created_at: r.created_at,
    intune_device_id: r.intune_device_id,
    aad_device_id:    r.aad_device_id,
    compliance_state: r.compliance_state,
    intune_last_sync: r.intune_last_sync,
    join_type:        r.join_type,
    enrolled_at:      r.enrolled_at,
    status: computeStatus(r, thr),
    user: r.user_id ? {
      id: r.user_id,
      name: r.user_name,
      email: r.user_email,
      job_title: r.user_job_title
    } : r.intune_user_display_name ? {
      name: r.intune_user_display_name,
      email: null,
      job_title: null
    } : null
  }
}

function computeStatus(d, thr) {
  if (!d.last_seen) return 'offline'
  const ageMs = Date.now() - new Date(d.last_seen).getTime()
  if (ageMs > 60 * 60 * 1000) return 'offline'
  if (d.disk_used_pct >= thr.critical) return 'critical'
  if (d.disk_used_pct >= thr.warn)     return 'warn'
  return 'online'
}
