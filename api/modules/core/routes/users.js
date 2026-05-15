import { searchAADUsers, getAllAADUsers, getUserPhoto, getEntraUser } from '../lib/graph.js'

// Cache photos en mémoire 1h pour éviter de re-fetcher Graph à chaque affichage
const photoCache = new Map()
function getCachedPhoto(id) {
  const entry = photoCache.get(id)
  if (entry && Date.now() < entry.expiresAt) return entry.data
  return null
}
function setCachedPhoto(id, data) {
  photoCache.set(id, { data, expiresAt: Date.now() + 3_600_000 })
}

export default async function usersRoute(fastify) {
  // GET /api/users — annuaire complet des salariés AAD
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    let users
    try {
      users = await getAllAADUsers(fastify.db)
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'getAllAADUsers échoué')
      // Microsoft Graph répond 400 si le filtre OData (settings users.filter_*)
      // référence une propriété qui n'existe pas dans le tenant. Message
      // explicite pour aider l'admin à corriger le filtre dans Paramètres.
      const isFilterErr = /\b400\b/.test(err.message)
      const userMsg = isFilterErr
        ? "Microsoft Graph a refusé la requête (HTTP 400). Vérifiez le filtre " +
          "configuré dans Paramètres → Filtre utilisateurs : la propriété " +
          "spécifiée doit exister sur les comptes de votre tenant Entra. " +
          "Pour les attributs étendus on-prem, utilisez " +
          "`onPremisesExtensionAttributes/extensionAttributeN` au lieu de " +
          "`extensionAttributeN`. Videz les deux champs pour désactiver le filtre."
        : `Annuaire Entra inaccessible : ${err.message}`
      return reply.code(502).send({ error: userMsg })
    }

    // Enrichir avec les devices assignés depuis notre DB
    const entraIds = users.map(u => u.id).filter(Boolean)
    const deviceMap = {}
    if (entraIds.length) {
      const res = await fastify.db.query(
        `SELECT assigned_user_id, id, hostname FROM devices WHERE assigned_user_id = ANY($1)`,
        [entraIds]
      )
      res.rows.forEach(d => { deviceMap[d.assigned_user_id] = d })
    }

    return users.map(u => ({
      entra_id:     u.id,
      display_name: u.displayName,
      email:        u.userPrincipalName,
      job_title:    u.jobTitle    || null,
      department:   u.department  || null,
      office:       u.officeLocation || null,
      device:       deviceMap[u.id]
        ? { id: deviceMap[u.id].id, hostname: deviceMap[u.id].hostname }
        : null,
    }))
  })

  // GET /api/users/:id/photo — proxy photo Graph avec cache 1h
  fastify.get('/:id/photo', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { id } = req.params
    let photo = getCachedPhoto(id)
    if (!photo) {
      photo = await getUserPhoto(id)
      if (!photo) return reply.code(404).send()
      setCachedPhoto(id, photo)
    }
    reply.header('Content-Type', photo.contentType)
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.send(photo.buffer)
  })

  // Appelé à chaque login — upsert user + retourne isAdmin
  fastify.post('/sync-me', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { entraId, email, displayName } = fastify.getUserIdentity(req)

    await fastify.db.query(
      `INSERT INTO users_cache (entra_id, display_name, email, synced_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (entra_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email        = EXCLUDED.email,
         synced_at    = now()`,
      [entraId, displayName, email]
    )

    const res = await fastify.db.query(
      'SELECT is_admin, job_title FROM users_cache WHERE entra_id = $1',
      [entraId]
    )

    return {
      entraId,
      displayName,
      email,
      isAdmin: res.rows[0]?.is_admin || false,
      jobTitle: res.rows[0]?.job_title || null
    }
  })

  // GET /api/users/:id — détail d'un utilisateur (vue admin avec
  // historique devices/tickets). Le profil perso passe par /sync-me.
  fastify.get('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { id } = req.params

    const [aadUser, deviceRes, ticketsRes] = await Promise.all([
      getEntraUser(fastify, id),
      fastify.db.query(
        `SELECT d.id, d.hostname, d.serial, d.model, d.manufacturer, d.os, d.os_build,
                d.ram_gb, d.disk_used_pct, d.disk_total_gb, d.ip_netbird,
                d.last_seen, d.compliance_state, d.intune_last_sync
         FROM devices d
         WHERE d.assigned_user_id = $1
         LIMIT 1`,
        [id]
      ),
      fastify.db.query(
        `SELECT t.id, t.title, t.status, t.priority, t.created_at
         FROM tickets t
         WHERE t.user_id = $1
         ORDER BY t.created_at DESC LIMIT 10`,
        [id]
      ),
    ])

    if (!aadUser) return reply.code(404).send({ error: 'Utilisateur introuvable' })

    const device = deviceRes.rows[0] || null

    return {
      entra_id:     aadUser.id,
      display_name: aadUser.displayName,
      email:        aadUser.userPrincipalName,
      job_title:    aadUser.jobTitle    || null,
      department:   aadUser.department  || null,
      device,
      tickets: ticketsRes.rows,
    }
  })

  // POST /api/users/sync-all — bulk-upsert tous les membres Entra → users_cache
  fastify.post('/sync-all', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    let users
    try {
      users = await getAllAADUsers(fastify.db)
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'sync-all: getAllAADUsers échoué')
      return reply.code(502).send({ error: `Graph: ${err.message}` })
    }

    if (users.length === 0) return reply.send({ synced: 0 })

    const { rows: [{ before }] } = await fastify.db.query('SELECT COUNT(*)::int AS before FROM users_cache')

    // Batch upsert via unnest — une seule requête quelle que soit la taille
    const ids    = users.map(u => u.id)
    const names  = users.map(u => u.displayName || null)
    const emails = users.map(u => u.userPrincipalName || u.mail || null)
    const jobs   = users.map(u => u.jobTitle || null)
    const depts  = users.map(u => u.department || null)

    await fastify.db.query(
      `INSERT INTO users_cache (entra_id, display_name, email, job_title, department, synced_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS t(entra_id, display_name, email, job_title, department),
         LATERAL (SELECT now()) AS ts(synced_at)
       ON CONFLICT (entra_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email        = EXCLUDED.email,
         job_title    = EXCLUDED.job_title,
         department   = EXCLUDED.department,
         synced_at    = EXCLUDED.synced_at`,
      [ids, names, emails, jobs, depts]
    )

    const { rows: [{ after }] } = await fastify.db.query('SELECT COUNT(*)::int AS after FROM users_cache')
    const byUser = fastify.getUserIdentity(req).displayName
    // NOTE RGPD : ce endpoint bulk-importe TOUT le tenant Entra dans users_cache,
    // au-delà des seuls utilisateurs "touchés par le RMM". Vérifier que la
    // charte interne autorise cette collecte étendue avant déploiement.
    await fastify.db.query(
      `INSERT INTO audit_logs (action, by_user, target, details) VALUES ('users_synced_all', $1, NULL, $2)`,
      [byUser, JSON.stringify({ count: users.length, before, after })]
    ).catch(err => fastify.log.warn({ err: err.message }, 'sync-all: audit log failed'))

    fastify.log.info({ count: users.length }, 'sync-all: users_cache mis à jour')
    reply.send({ synced: users.length })
  })

  // Recherche dans users_cache (personnes connectées au RMM)
  fastify.get('/search', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { q } = req.query
    if (!q || q.length < 2) return []
    const res = await fastify.db.query(
      `SELECT entra_id, display_name, email, job_title
       FROM users_cache
       WHERE display_name ILIKE $1 OR email ILIKE $1
       ORDER BY display_name LIMIT 10`,
      [`%${q}%`]
    )
    return res.rows
  })

  // Recherche dans Entra ID (tous les utilisateurs AAD)
  fastify.get('/search-aad', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { q } = req.query
    if (!q || q.length < 2) return []
    try {
      const users = await searchAADUsers(q, fastify.db)
      return users.map(u => ({
        entra_id:     u.id,
        display_name: u.displayName,
        email:        u.userPrincipalName,
        job_title:    u.jobTitle || null,
        department:   u.department || null,
      }))
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'AAD search échoué, fallback users_cache')
      const res = await fastify.db.query(
        `SELECT entra_id, display_name, email, job_title, NULL AS department
         FROM users_cache WHERE display_name ILIKE $1 OR email ILIKE $1
         ORDER BY display_name LIMIT 10`,
        [`%${q}%`]
      )
      return res.rows
    }
  })
}
