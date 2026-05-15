import crypto from 'crypto'
import { getAppToken, invalidateUserFilterCache } from '../lib/graph.js'
import { logAudit } from '../lib/audit.js'

// ─── Helpers ───
function genToken() {
  return crypto.randomBytes(32).toString('hex')
}
function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex')
}

async function graphGetAll(path) {
  const token = await getAppToken()
  let url = `https://graph.microsoft.com/v1.0${path}`
  const items = []
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph ${path}: ${res.status}`)
    const data = await res.json()
    items.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return items
}

export default async function settingsRoute(fastify) {

  // GET /api/settings — tout en une requête (sans audit — chargé séparément)
  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const [settingsRows, tokensRows, adminsRows, sshKeysRows, cliTokensRows] = await Promise.all([
      fastify.db.query('SELECT key, value FROM settings ORDER BY key'),
      fastify.db.query(`
        SELECT t.id, t.label, t.created_at, t.revoked_at, t.last_used_at, t.created_by,
               d.hostname
        FROM agent_tokens t
        LEFT JOIN devices d ON d.id = t.device_id
        ORDER BY t.created_at DESC
      `),
      fastify.db.query('SELECT entra_id, display_name, email, is_admin, synced_at FROM users_cache ORDER BY display_name'),
      fastify.db.query('SELECT id, label, public_key, created_at, created_by FROM ssh_keys ORDER BY created_at'),
      fastify.db.query(`
        SELECT ct.id, ct.label, ct.entra_id, ct.created_by, ct.created_at,
               ct.expires_at, ct.revoked_at, ct.last_used_at,
               uc.display_name AS owner_name
        FROM cli_tokens ct
        LEFT JOIN users_cache uc ON uc.entra_id = ct.entra_id
        ORDER BY ct.created_at DESC
      `),
    ])

    reply.send({
      settings:   Object.fromEntries(settingsRows.rows.map(r => [r.key, r.value])),
      tokens:     tokensRows.rows,
      admins:     adminsRows.rows,
      ssh_keys:   sshKeysRows.rows,
      cli_tokens: cliTokensRows.rows,
    })
  })

  // GET /api/settings/audit — journal avec filtres et pagination
  // - action          : action exacte (legacy, conservé pour compat)
  // - actions_in      : CSV d'actions autorisées (catégorie côté UI)
  // - actions_not_in  : CSV d'actions exclues (ex: masquer les events bruyants)
  fastify.get('/audit', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { action, actions_in, actions_not_in, level, limit = 100, offset = 0 } = req.query
    const conds  = []
    const params = []
    let i = 1

    if (action) { conds.push(`al.action = $${i++}`); params.push(action) }
    if (actions_in) {
      const list = String(actions_in).split(',').map(s => s.trim()).filter(Boolean)
      if (list.length) { conds.push(`al.action = ANY($${i++}::text[])`); params.push(list) }
    }
    if (actions_not_in) {
      const list = String(actions_not_in).split(',').map(s => s.trim()).filter(Boolean)
      if (list.length) { conds.push(`al.action <> ALL($${i++}::text[])`); params.push(list) }
    }
    if (level)  { conds.push(`al.details->>'level' = $${i++}`); params.push(level) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    params.push(parseInt(limit), parseInt(offset))

    const [rows, total] = await Promise.all([
      fastify.db.query(
        // Pour agent_checkin, target = device_id (UUID). Pour les autres
        // actions, target = hostname. On joint sur les deux (par
        // hostname ET par UUID si le format match) puis COALESCE — un
        // seul des deux match jamais les deux à la fois.
        `SELECT al.id, al.action, al.by_user, al.target, al.details, al.created_at,
                COALESCE(d_host.id, d_uuid.id)                                       AS device_id,
                COALESCE(d_host.hostname, d_uuid.hostname)                           AS device_hostname,
                COALESCE(du_host.entra_id, du_uuid.entra_id)                         AS device_user_entra_id,
                COALESCE(du_host.email, du_uuid.email)                               AS device_user_email,
                COALESCE(du_host.display_name, du_uuid.display_name)                 AS device_user_name,
                bu.entra_id                                                          AS by_user_entra_id,
                bu.email                                                             AS by_user_email
         FROM audit_logs al
         LEFT JOIN devices     d_host  ON d_host.hostname  = al.target
         -- d_uuid.id::text = al.target : on cast d_uuid (toujours UUID
         -- valide) en text plutôt que target (peut être n'importe quoi)
         -- en uuid. Évite "invalid input syntax for type uuid" quand
         -- target = "Clément Boutin" etc. Le planner Postgres pouvait
         -- évaluer le cast::uuid avant le regex guard.
         LEFT JOIN devices     d_uuid  ON d_uuid.id::text   = al.target
         LEFT JOIN users_cache du_host ON du_host.entra_id  = d_host.assigned_user_id
         LEFT JOIN users_cache du_uuid ON du_uuid.entra_id  = d_uuid.assigned_user_id
         -- LEFT JOIN LATERAL + LIMIT 1 : display_name n'est PAS unique dans
         -- users_cache (homonymes possibles dans le tenant Entra). Un JOIN
         -- classique multiplierait chaque audit_log par le nombre d'homonymes,
         -- ce qui dupliquait les rows côté UI (observé : 2 'console ouverte'
         -- pour 1 vrai insert).
         LEFT JOIN LATERAL (
           SELECT entra_id, email
           FROM users_cache
           WHERE display_name = al.by_user
           LIMIT 1
         ) bu ON true
         ${where}
         ORDER BY al.created_at DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        params
      ),
      fastify.db.query(
        `SELECT COUNT(*) FROM audit_logs al ${where}`,
        params.slice(0, -2)
      ),
    ])

    reply.send({ rows: rows.rows, total: parseInt(total.rows[0].count) })
  })

  // PATCH /api/settings — mettre à jour des clés
  fastify.patch('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { displayName } = fastify.getUserIdentity(req)
    const allowed = [
      'disk_warn_pct', 'disk_critical_pct', 'agent_offline_days', 'ssh_public_key', 'cost_per_hour',
      // Branding (exposés via /env.js → window.ENV.BRANDING et /manifest.json)
      'org.name', 'app.product_name', 'app.tagline', 'app.default_role_label',
      // Filtre listing utilisateurs Graph (vide = pas de filtre supplémentaire)
      'users.filter_attribute', 'users.filter_value',
      // Agent : nom du compte LAPS recovery — lu par l'agent Go via /api/agent/runtime-config
      'agent.laps_recovery_username',
      // Conformité : toggle push + ticket_proposal sur transitions critical/high
      // (cf. api/lib/compliance.js, lu à chaque checkin)
      'compliance_alerts_enabled',
    ]
    // Validation des valeurs sensibles côté serveur — defense in depth.
    // Le client valide déjà et l'agent Go refuse les noms sensibles, mais
    // le PATCH est une frontière système : on bloque ici aussi.
    if (req.body?.['agent.laps_recovery_username'] !== undefined) {
      const v = String(req.body['agent.laps_recovery_username']).trim()
      const BANNED = new Set(['administrator', 'administrateur', 'admin', 'root', 'system', ''])
      if (BANNED.has(v.toLowerCase()) || !/^[A-Za-z0-9_.-]{1,32}$/.test(v)) {
        return reply.code(400).send({
          error: 'agent.laps_recovery_username invalide (caractères [A-Za-z0-9_.-], 1-32, hors comptes sensibles)',
        })
      }
    }
    // compliance_alerts_enabled : strictement 'true' ou 'false' (stocké en
    // TEXT, lu côté compliance.js avec value === 'true'). Refuse les
    // entrées libres (ex: '1', 'yes', booléen JSON) qui mèneraient à des
    // comportements silencieusement faux.
    if (req.body?.compliance_alerts_enabled !== undefined) {
      const v = String(req.body.compliance_alerts_enabled)
      if (v !== 'true' && v !== 'false') {
        return reply.code(400).send({
          error: "compliance_alerts_enabled doit valoir 'true' ou 'false'",
        })
      }
    }

    let brandingTouched = false
    let userFilterTouched = false
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        await fastify.db.query(`
          INSERT INTO settings (key, value, updated_at, updated_by)
          VALUES ($1, $2, now(), $3)
          ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3
        `, [key, String(req.body[key]), displayName])
        if (key.startsWith('org.') || key.startsWith('app.')) brandingTouched = true
        if (key.startsWith('users.filter_')) userFilterTouched = true
      }
    }
    if (brandingTouched) {
      fastify.invalidateBrandingCache()
      fastify.invalidateManifestCache()
    }
    if (userFilterTouched) invalidateUserFilterCache()
    const { rows } = await fastify.db.query('SELECT key, value FROM settings ORDER BY key')
    reply.send(Object.fromEntries(rows.map(r => [r.key, r.value])))
  })

  // POST /api/settings/tokens — créer un token agent
  fastify.post('/tokens', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { label } = req.body || {}
    if (!label) return reply.code(400).send({ error: 'Label requis' })
    const { displayName } = fastify.getUserIdentity(req)
    const plain = genToken()
    const hash  = hashToken(plain)
    const { rows } = await fastify.db.query(`
      INSERT INTO agent_tokens (label, token_hash, created_by)
      VALUES ($1, $2, $3) RETURNING id, label, created_at, created_by
    `, [label, hash, displayName])

    // Journal
    await logAudit(fastify.db, fastify.log, { action: 'token_created', byUser: displayName, target: label })

    // On retourne le token en clair UNE SEULE FOIS
    reply.code(201).send({ ...rows[0], token: plain })
  })

  // DELETE /api/settings/tokens/:id — révoquer
  fastify.delete('/tokens/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      UPDATE agent_tokens SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL RETURNING label
    `, [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Token introuvable ou déjà révoqué' })

    await logAudit(fastify.db, fastify.log, { action: 'token_revoked', byUser: displayName, target: rows[0].label })
    reply.code(204).send()
  })

  // DELETE /api/settings/cli-tokens/:id — révoquer un token CLI
  fastify.delete('/cli-tokens/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      UPDATE cli_tokens SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL RETURNING label
    `, [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Token introuvable ou déjà révoqué' })
    await logAudit(fastify.db, fastify.log, { action: 'cli_token_revoked', byUser: displayName, target: rows[0].label })
    reply.code(204).send()
  })

  // POST /api/settings/ssh-keys — ajouter une clé SSH
  fastify.post('/ssh-keys', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { label, public_key } = req.body || {}
    if (!label || !public_key) return reply.code(400).send({ error: 'label et public_key requis' })
    const { displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(
      `INSERT INTO ssh_keys (label, public_key, created_by) VALUES ($1, $2, $3)
       RETURNING id, label, public_key, created_at, created_by`,
      [label.trim(), public_key.trim(), displayName]
    )
    reply.code(201).send(rows[0])
  })

  // DELETE /api/settings/ssh-keys/:id — supprimer une clé SSH
  fastify.delete('/ssh-keys/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `DELETE FROM ssh_keys WHERE id = $1 RETURNING label`, [req.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Clé introuvable' })
    reply.code(204).send()
  })

  // PATCH /api/settings/admins/:entraId — toggler admin
  fastify.patch('/admins/:entraId', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { is_admin } = req.body || {}
    if (typeof is_admin !== 'boolean') return reply.code(400).send({ error: 'is_admin (bool) requis' })
    const { displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      UPDATE users_cache SET is_admin = $1 WHERE entra_id = $2 RETURNING entra_id, display_name, is_admin
    `, [is_admin, req.params.entraId])
    if (!rows.length) return reply.code(404).send({ error: 'Utilisateur introuvable' })

    await logAudit(fastify.db, fastify.log, {
      action:  is_admin ? 'admin_granted' : 'admin_revoked',
      byUser:  displayName,
      target:  rows[0].display_name,
      details: { entra_id: req.params.entraId },
    })
    reply.send(rows[0])
  })

  // POST /api/settings/sync-intune — sync complète depuis Intune
  fastify.post('/sync-intune', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { displayName } = fastify.getUserIdentity(req)
    let upserted   = 0
    let errors     = 0
    const errorLog = []

    try {
      const devices = await graphGetAll(
        '/deviceManagement/managedDevices' +
        '?$select=id,deviceName,serialNumber,model,manufacturer,operatingSystem,osVersion,' +
        'userId,userDisplayName,totalStorageSpaceInBytes,freeStorageSpaceInBytes,physicalMemoryInBytes,' +
        'azureADDeviceId,complianceState,lastSyncDateTime,enrolledDateTime&$top=999'
      )

      // Upsert d'abord tous les utilisateurs Intune dans users_cache pour satisfaire la FK
      const intuneUsers = [...new Map(
        devices
          .filter(d => d.userId && d.userDisplayName)
          .map(d => [d.userId, d])
      ).values()]
      if (intuneUsers.length) {
        await fastify.db.query(`
          INSERT INTO users_cache (entra_id, display_name, synced_at)
          SELECT u.entra_id, u.display_name, now()
          FROM jsonb_to_recordset($1::jsonb) AS u(entra_id text, display_name text)
          ON CONFLICT (entra_id) DO UPDATE SET
            display_name = COALESCE(EXCLUDED.display_name, users_cache.display_name),
            synced_at    = now()
        `, [JSON.stringify(intuneUsers.map(d => ({ entra_id: d.userId, display_name: d.userDisplayName })))])
      }

      for (const d of devices) {
        const FAKE_SERIALS = new Set(['unknown', 'systemserialnumber', 'system serial number',
          'to be filled by o.e.m.', 'to be filled', 'none', 'n/a', 'default string', '0'])
        const serial = (!d.serialNumber || FAKE_SERIALS.has(d.serialNumber.toLowerCase().trim())) ? null : d.serialNumber
        if (!serial && !d.deviceName) continue

        const totalBytes = d.totalStorageSpaceInBytes || 0
        const freeBytes  = d.freeStorageSpaceInBytes  || 0
        const diskPct    = totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 100) : null
        const diskTotalGb = totalBytes > 0 ? Math.round(totalBytes / (1024 ** 3)) : null
        const ramGb      = d.physicalMemoryInBytes > 0
          ? Math.round(d.physicalMemoryInBytes / (1024 ** 3))
          : null

        const conflictClause = serial
          ? `ON CONFLICT (serial)`
          : `ON CONFLICT (hostname)`
        const updateSet = `
              hostname                 = EXCLUDED.hostname,
              model                    = EXCLUDED.model,
              manufacturer             = EXCLUDED.manufacturer,
              os                       = EXCLUDED.os,
              os_build                 = EXCLUDED.os_build,
              ram_gb                   = COALESCE(EXCLUDED.ram_gb,        devices.ram_gb),
              disk_used_pct            = COALESCE(EXCLUDED.disk_used_pct, devices.disk_used_pct),
              disk_total_gb            = COALESCE(EXCLUDED.disk_total_gb, devices.disk_total_gb),
              intune_device_id         = EXCLUDED.intune_device_id,
              aad_device_id            = EXCLUDED.aad_device_id,
              intune_user_id           = EXCLUDED.intune_user_id,
              intune_user_display_name = EXCLUDED.intune_user_display_name,
              compliance_state         = EXCLUDED.compliance_state,
              intune_last_sync         = EXCLUDED.intune_last_sync,
              enrolled_at              = EXCLUDED.enrolled_at,
              assigned_user_id         = COALESCE(EXCLUDED.assigned_user_id, devices.assigned_user_id)`

        try {
          await fastify.db.query(`
            INSERT INTO devices (
              hostname, serial, model, manufacturer, os, os_build,
              ram_gb, disk_used_pct, disk_total_gb,
              intune_device_id, aad_device_id, intune_user_id, intune_user_display_name,
              compliance_state, intune_last_sync, enrolled_at,
              assigned_user_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$12)
            ${conflictClause} DO UPDATE SET ${updateSet}
          `, [
            d.deviceName       || null,
            serial,
            d.model            || null,
            d.manufacturer     || null,
            d.operatingSystem  || null,
            d.osVersion        || null,
            ramGb,
            diskPct,
            diskTotalGb,
            d.id               || null,
            d.azureADDeviceId  || null,
            d.userId           || null,
            d.userDisplayName  || null,
            d.complianceState  || null,
            d.lastSyncDateTime || null,
            d.enrolledDateTime || null,
          ])
          upserted++
        } catch (err) {
          errors++
          errorLog.push(`[${d.deviceName || '?'}] ${err.message}`)
        }
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }

    await logAudit(fastify.db, fastify.log, {
      action:  'intune_sync',
      byUser:  displayName,
      details: { upserted, errors, ...(errorLog.length ? { log: errorLog.join('\n') } : {}) },
    })

    reply.send({ upserted, errors })
  })
}
