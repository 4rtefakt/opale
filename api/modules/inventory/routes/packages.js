import { getGroupDeviceHostnames } from '../../core/lib/graph.js'
import { resolveGroupMembers } from '../../groups/lib/groups.js'

// Gestion des packages déployables (winget ou script PowerShell)
export default async function packagesRoute(fastify) {

  // GET /api/packages/winget/search — autocomplétion sur l'index officiel
  // Microsoft (source2.msix mis en cache mémoire par fastify.winget).
  // Volontairement placée AVANT '/:id' pour ne pas être capturée par la
  // route paramétrée. Auth normale (admin pas requis : c'est juste de la
  // lecture sur un index public).
  fastify.get('/winget/search', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const q = String(req.query?.q || '').trim()
    const limit = parseInt(req.query?.limit, 10) || 20
    if (q.length < 2) return reply.send({ ready: true, results: [] })
    // On répond 200 même si l'index n'est pas encore prêt : le front affiche
    // un état "chargement" sans déclencher son path d'erreur. C'est de la
    // dégradation gracieuse, pas une vraie erreur côté client.
    if (!fastify.winget.ready()) {
      return reply.send({ ready: false, results: [] })
    }
    const out = fastify.winget.search(q, limit)
    reply.send({ ...out, last_updated: fastify.winget.lastUpdated })
  })

  // GET /api/packages — liste avec stats de couverture
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    // Counts par DEVICE UNIQUE (pas par row de deployment) : un PC qui a
    // 2 deployments réussis = 1 device "success", pas 2. Évite les écarts
    // entre nombre affiché et nombre de PCs réellement touchés. Un même
    // device peut compter dans plusieurs catégories (ex: success + un
    // nouveau pending) — c'est intentionnel et reflète l'état réel.
    const { rows } = await fastify.db.query(`
      SELECT
        p.*,
        u.display_name AS approved_by_name,
        c.display_name AS created_by_name,
        COUNT(DISTINCT d.device_id) FILTER (WHERE d.status = 'pending')  AS pending_count,
        COUNT(DISTINCT d.device_id) FILTER (WHERE d.status = 'running')  AS running_count,
        COUNT(DISTINCT d.device_id) FILTER (WHERE d.status = 'success')  AS success_count,
        COUNT(DISTINCT d.device_id) FILTER (WHERE d.status = 'failed')   AS failed_count,
        COUNT(DISTINCT s.device_id) FILTER (WHERE s.detected)            AS detected_count,
        (SELECT COUNT(*) FROM devices WHERE last_seen > now() - INTERVAL '24h') AS total_devices
      FROM packages p
      LEFT JOIN users_cache u ON u.entra_id = p.approved_by
      LEFT JOIN users_cache c ON c.entra_id = p.created_by
      LEFT JOIN deployments d ON d.package_id = p.id
      LEFT JOIN device_software s ON s.package_id = p.id
      GROUP BY p.id, u.display_name, c.display_name
      ORDER BY p.created_at DESC
    `)
    reply.send(rows)
  })

  // POST /api/packages — créer un package (draft)
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { name, description, type, winget_id, install_script, post_install_script, detection_script, version } = req.body || {}
    if (!name) return reply.code(400).send({ error: 'name requis' })
    if (type === 'winget' && !winget_id) return reply.code(400).send({ error: 'winget_id requis pour type=winget' })
    if (type === 'script' && !install_script) return reply.code(400).send({ error: 'install_script requis pour type=script' })

    const { entraId } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      INSERT INTO packages (name, description, type, winget_id, install_script, post_install_script, detection_script, version, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, description || null, type || 'winget', winget_id || null, install_script || null, post_install_script || null, detection_script || null, version || null, entraId])

    reply.code(201).send(rows[0])
  })

  // GET /api/packages/:id — détail + historique déploiements
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows: [pkg] } = await fastify.db.query(`
      SELECT p.*, u.display_name AS approved_by_name, c.display_name AS created_by_name
      FROM packages p
      LEFT JOIN users_cache u ON u.entra_id = p.approved_by
      LEFT JOIN users_cache c ON c.entra_id = p.created_by
      WHERE p.id = $1
    `, [req.params.id])
    if (!pkg) return reply.code(404).send({ error: 'Package introuvable' })

    // Derniers déploiements (300 max — pour la table). Les KPIs en haut
    // utilisent les counts agrégés ci-dessous (pas filter sur ces rows).
    // 300 couvre le besoin typique d'une PME (<5k devices) sans avoir à
    // paginer côté serveur. Au-delà, ajouter une pagination ou un filtre.
    // assigned_user_name vient de users_cache (assigned_user_id),
    // intune_user_display_name est le fallback Intune si pas synchro Entra.
    const { rows: deployments } = await fastify.db.query(`
      SELECT d.*,
             dev.hostname,
             dev.ip_netbird,
             dev.assigned_user_id,
             dev.intune_user_display_name,
             au.display_name AS assigned_user_name,
             uc.display_name AS deployed_by_name
      FROM deployments d
      JOIN devices dev          ON dev.id      = d.device_id
      LEFT JOIN users_cache au  ON au.entra_id = dev.assigned_user_id
      LEFT JOIN users_cache uc  ON uc.entra_id = d.deployed_by
      WHERE d.package_id = $1
      ORDER BY d.queued_at DESC
      LIMIT 300
    `, [req.params.id])

    // Counts par DEVICE UNIQUE (pas par row), pour cohérence avec la
    // sémantique "X PCs touchés". Un device avec 2 deployments réussis
    // ne compte qu'une fois en success. Un device peut apparaître dans
    // plusieurs catégories (ex: success + nouveau pending) si re-déploy.
    const { rows: [counts] } = await fastify.db.query(`
      SELECT
        COUNT(DISTINCT device_id) FILTER (WHERE status = 'pending')   AS pending,
        COUNT(DISTINCT device_id) FILTER (WHERE status = 'running')   AS running,
        COUNT(DISTINCT device_id) FILTER (WHERE status = 'success')   AS success,
        COUNT(DISTINCT device_id) FILTER (WHERE status = 'failed')    AS failed,
        COUNT(DISTINCT device_id) FILTER (WHERE status = 'cancelled') AS cancelled,
        COUNT(DISTINCT device_id)                                     AS unique_devices,
        COUNT(*)                                                      AS total_rows
      FROM deployments
      WHERE package_id = $1
    `, [req.params.id])

    const { rows: [{ detected }] } = await fastify.db.query(`
      SELECT COUNT(DISTINCT device_id) FILTER (WHERE detected) AS detected
      FROM device_software
      WHERE package_id = $1
    `, [req.params.id])

    counts.detected = detected
    // Cast text → int (PG COUNT renvoie des bigint = string en JS)
    for (const k of Object.keys(counts)) counts[k] = parseInt(counts[k]) || 0

    // Inventaire logiciel
    const { rows: software } = await fastify.db.query(`
      SELECT s.*, dev.hostname
      FROM device_software s
      JOIN devices dev ON dev.id = s.device_id
      WHERE s.package_id = $1
    `, [req.params.id])

    // Jobs actifs (scope=group|all|user) — déploiements perpétuels qui
    // s'appliquent aussi aux nouveaux PCs / nouveaux membres de groupe /
    // nouveaux PCs assignés au user au prochain checkin.
    const { rows: active_jobs } = await fastify.db.query(`
      SELECT j.id, j.scope, j.source_group_id, j.user_entra_id, j.created_at,
             uc.display_name   AS deployed_by_name,
             tu.display_name   AS target_user_name
      FROM deployment_jobs j
      LEFT JOIN users_cache uc ON uc.entra_id = j.deployed_by
      LEFT JOIN users_cache tu ON tu.entra_id = j.user_entra_id
      WHERE j.package_id = $1 AND j.status = 'active'
      ORDER BY j.created_at DESC
    `, [req.params.id])

    reply.send({ ...pkg, deployments, counts, software, active_jobs })
  })

  // POST /api/packages/:id/cancel-all — coupure d'urgence : annule tous
  // les déploiements pending de ce package ET stoppe tous les jobs
  // perpétuels actifs (scope=all|group|user). Les déploiements 'running'
  // ne sont PAS touchés : l'agent les exécute déjà localement, le DB
  // marquage cancelled ne les arrêterait pas et créerait juste une
  // incohérence avec le résultat agent qui arrivera. Ils se résoudront
  // naturellement (success/failed) ou par le timeout 1h.
  fastify.post('/:id/cancel-all', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: [pkg] } = await fastify.db.query(`SELECT id FROM packages WHERE id = $1`, [req.params.id])
    if (!pkg) return reply.code(404).send({ error: 'Package introuvable' })

    const { rows: deps } = await fastify.db.query(`
      UPDATE deployments SET status = 'cancelled', completed_at = now()
      WHERE package_id = $1 AND status = 'pending'
      RETURNING id
    `, [req.params.id])

    const { rows: jobs } = await fastify.db.query(`
      UPDATE deployment_jobs SET status = 'cancelled'
      WHERE package_id = $1 AND status = 'active'
      RETURNING id
    `, [req.params.id])

    const { rows: [{ running_count }] } = await fastify.db.query(`
      SELECT COUNT(*) AS running_count FROM deployments
      WHERE package_id = $1 AND status = 'running'
    `, [req.params.id])

    reply.send({
      cancelled_deployments: deps.length,
      cancelled_jobs:        jobs.length,
      running_left:          parseInt(running_count),
    })
  })

  // POST /api/packages/jobs/:jobId/cancel — stoppe un déploiement automatique
  // perpétuel. Les nouveaux PCs ne recevront plus le package via ce job.
  // Les déploiements déjà créés (en file ou exécutés) ne sont PAS annulés.
  fastify.post('/jobs/:jobId/cancel', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `UPDATE deployment_jobs SET status = 'cancelled' WHERE id = $1 AND status = 'active' RETURNING id`,
      [req.params.jobId]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Job introuvable ou déjà annulé' })
    reply.send({ id: rows[0].id, status: 'cancelled' })
  })

  // PATCH /api/packages/:id — modifier (repasse en draft si approuvé)
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows: [existing] } = await fastify.db.query(`SELECT * FROM packages WHERE id = $1`, [req.params.id])
    if (!existing) return reply.code(404).send({ error: 'Package introuvable' })

    const { name, description, type, winget_id, install_script, post_install_script, detection_script, version } = req.body || {}

    // Toute modification d'un package approuvé le repasse en draft
    const newStatus = existing.status === 'approved' ? 'draft' : existing.status

    const { rows } = await fastify.db.query(`
      UPDATE packages SET
        name                = COALESCE($1, name),
        description         = COALESCE($2, description),
        type                = COALESCE($3, type),
        winget_id           = COALESCE($4, winget_id),
        install_script      = COALESCE($5, install_script),
        post_install_script = COALESCE($6, post_install_script),
        detection_script    = COALESCE($7, detection_script),
        version             = COALESCE($8, version),
        status              = $9,
        approved_by         = CASE WHEN $9 = 'draft' THEN NULL ELSE approved_by END,
        approved_at         = CASE WHEN $9 = 'draft' THEN NULL ELSE approved_at END,
        updated_at          = now()
      WHERE id = $10
      RETURNING *
    `, [name || null, description || null, type || null, winget_id || null,
        install_script || null, post_install_script || null, detection_script || null, version || null,
        newStatus, req.params.id])

    reply.send(rows[0])
  })

  // DELETE /api/packages/:id — supprimer (bloqué si déploiements actifs)
  fastify.delete('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows: active } = await fastify.db.query(`
      SELECT id FROM deployments WHERE package_id = $1 AND status IN ('pending','running') LIMIT 1
    `, [req.params.id])
    if (active.length) return reply.code(409).send({ error: 'Des déploiements sont en cours — annulez-les d\'abord' })

    await fastify.db.query(`DELETE FROM packages WHERE id = $1`, [req.params.id])
    reply.code(204).send()
  })

  // POST /api/packages/:id/approve — approuver (admin requis)
  fastify.post('/:id/approve', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: [pkg] } = await fastify.db.query(`SELECT * FROM packages WHERE id = $1`, [req.params.id])
    if (!pkg) return reply.code(404).send({ error: 'Package introuvable' })
    if (pkg.status === 'approved') return reply.code(409).send({ error: 'Package déjà approuvé' })

    const { entraId } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      UPDATE packages SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
      WHERE id = $2
      RETURNING *
    `, [entraId, req.params.id])

    reply.send(rows[0])
  })

  // POST /api/packages/:id/deploy — créer des déploiements (1-par-1, groupe Entra, ou global)
  // Body :
  //   scope='device' (défaut) : { device_ids: [...], confirmed? }
  //   scope='group'           : { group_id: '<entra-object-id>', confirmed? }
  //   scope='all'             : { confirmed? }
  //   scope='user'            : { user_entra_id: '<entra-id>', confirmed? }
  //                             — déploie sur tous les PCs assignés à ce
  //                             user, et redéclenche au prochain checkin
  //                             si le user est réassigné à un nouveau PC
  fastify.post('/:id/deploy', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: [pkg] } = await fastify.db.query(`SELECT * FROM packages WHERE id = $1`, [req.params.id])
    if (!pkg) return reply.code(404).send({ error: 'Package introuvable' })
    if (pkg.status !== 'approved') return reply.code(409).send({ error: 'Le package doit être approuvé avant déploiement' })

    const { scope = 'device', device_ids, group_id, native_group_id, user_entra_id, confirmed } = req.body || {}
    const { entraId } = fastify.getUserIdentity(req)

    let resolvedDeviceIds = []
    let unmatched = 0
    let job = null

    if (scope === 'device') {
      if (!Array.isArray(device_ids) || device_ids.length === 0) {
        return reply.code(400).send({ error: 'device_ids requis (tableau non vide) pour scope=device' })
      }
      resolvedDeviceIds = device_ids

    } else if (scope === 'group') {
      if (!group_id) return reply.code(400).send({ error: 'group_id requis pour scope=group' })
      let hostnames
      try {
        hostnames = await getGroupDeviceHostnames(group_id)
      } catch (err) {
        fastify.log.warn({ err: err.message, group_id }, 'deploy: résolution groupe Entra échouée')
        return reply.code(502).send({ error: `Impossible de résoudre le groupe Entra : ${err.message}` })
      }
      if (!hostnames.length) return reply.code(400).send({ error: 'Groupe vide ou aucun device Entra trouvé' })
      const { rows: matched } = await fastify.db.query(
        `SELECT id FROM devices WHERE hostname = ANY($1::text[])`, [hostnames]
      )
      resolvedDeviceIds = matched.map(r => r.id)
      unmatched = hostnames.length - resolvedDeviceIds.length

    } else if (scope === 'native_group') {
      if (!native_group_id) return reply.code(400).send({ error: 'native_group_id requis pour scope=native_group' })
      const { devices } = await resolveGroupMembers(fastify.db, native_group_id)
      resolvedDeviceIds = devices.map(d => d.device_id)
      if (!resolvedDeviceIds.length) return reply.code(400).send({ error: 'Groupe natif vide ou ne contient aucun poste' })

    } else if (scope === 'all') {
      const { rows: allDevices } = await fastify.db.query(`SELECT id FROM devices`)
      resolvedDeviceIds = allDevices.map(r => r.id)

    } else if (scope === 'user') {
      if (!user_entra_id) return reply.code(400).send({ error: 'user_entra_id requis pour scope=user' })
      // Upsert minimal du user dans users_cache (sinon FK du job échoue) ;
      // les attributs (display_name, email) sont resyncés par d'autres routes.
      await fastify.db.query(
        `INSERT INTO users_cache (entra_id) VALUES ($1) ON CONFLICT (entra_id) DO NOTHING`,
        [user_entra_id]
      )
      const { rows: userDevices } = await fastify.db.query(
        `SELECT id FROM devices WHERE assigned_user_id = $1`, [user_entra_id]
      )
      resolvedDeviceIds = userDevices.map(r => r.id)
      // Note : 0 device est acceptable ici — le job devient actif et
      // déploiera sur le premier PC qui sera assigné à ce user.
      // On créé donc le job même avec resolvedDeviceIds vide.

    } else {
      return reply.code(400).send({ error: 'scope invalide — valeurs acceptées : device, group, native_group, all, user' })
    }

    if (resolvedDeviceIds.length === 0 && scope !== 'user') {
      return reply.code(400).send({ error: 'Aucun device managé trouvé pour ce scope', unmatched })
    }

    // Garde : plus de 10 devices nécessite confirmation explicite.
    // Renvoie 200 (pas 400) pour que le client puisse interroger le flag
    // sans déclencher le path d'erreur ; c'est un succès partiel "ok mais
    // besoin de confirm", pas une erreur de requête.
    if (resolvedDeviceIds.length > 10 && !confirmed) {
      return reply.send({
        requires_confirmation: true,
        count: resolvedDeviceIds.length,
        unmatched,
        message: `Déploiement sur ${resolvedDeviceIds.length} postes — confirmez en ajoutant "confirmed": true`,
      })
    }

    // Créer le job template pour scope group|all|user (traçabilité +
    // fan-out lazy au checkin agent). Le job reste actif et redéclenche
    // les déploiements sur les nouveaux devices qui matchent (nouveau PC
    // managé, nouveau membre de groupe, nouveau PC assigné au user).
    if (scope !== 'device') {
      const { rows: [j] } = await fastify.db.query(`
        INSERT INTO deployment_jobs (package_id, scope, source_group_id, native_group_id, user_entra_id, deployed_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        pkg.id,
        scope,
        scope === 'group'        ? group_id        : null,
        scope === 'native_group' ? native_group_id  : null,
        scope === 'user'         ? user_entra_id    : null,
        entraId,
      ])
      job = j
    }

    let queued = 0
    for (const deviceId of resolvedDeviceIds) {
      try {
        await fastify.db.query(`
          INSERT INTO deployments (package_id, device_id, deployed_by, job_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `, [pkg.id, deviceId, entraId, job?.id ?? null])
        queued++
      } catch (err) {
        fastify.log.debug({ err: err.message, deviceId }, 'deploy skip')
      }
    }

    const resp = { queued, total: resolvedDeviceIds.length }
    if (unmatched) resp.unmatched = unmatched
    if (job) resp.job_id = job.id
    reply.code(201).send(resp)
  })
}
