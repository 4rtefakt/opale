// Suivi des déploiements de packages
export default async function deploymentsRoute(fastify) {

  // GET /api/deployments — liste avec filtres
  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { status, package_id, device_id, limit = 100, offset = 0 } = req.query || {}

    const conds = []
    const vals  = []
    let i = 1

    if (status)     { conds.push(`d.status = $${i++}`);     vals.push(status) }
    if (package_id) { conds.push(`d.package_id = $${i++}`); vals.push(package_id) }
    if (device_id)  { conds.push(`d.device_id = $${i++}`);  vals.push(device_id) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''

    const { rows } = await fastify.db.query(`
      SELECT
        d.*,
        p.name  AS package_name,
        p.type  AS package_type,
        dev.hostname,
        dev.ip_netbird,
        uc.display_name AS deployed_by_name
      FROM deployments d
      JOIN packages p    ON p.id  = d.package_id
      JOIN devices  dev  ON dev.id = d.device_id
      LEFT JOIN users_cache uc ON uc.entra_id = d.deployed_by
      ${where}
      ORDER BY d.queued_at DESC
      LIMIT $${i} OFFSET $${i + 1}
    `, [...vals, parseInt(limit), parseInt(offset)])

    const { rows: [{ total }] } = await fastify.db.query(`
      SELECT COUNT(*) AS total FROM deployments d ${where}
    `, vals)

    reply.send({ rows, total: parseInt(total) })
  })

  // GET /api/deployments/:id — détail
  fastify.get('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: [row] } = await fastify.db.query(`
      SELECT d.*, p.name AS package_name, p.type AS package_type,
             dev.hostname, uc.display_name AS deployed_by_name
      FROM deployments d
      JOIN packages p   ON p.id  = d.package_id
      JOIN devices dev  ON dev.id = d.device_id
      LEFT JOIN users_cache uc ON uc.entra_id = d.deployed_by
      WHERE d.id = $1
    `, [req.params.id])

    if (!row) return reply.code(404).send({ error: 'Déploiement introuvable' })
    reply.send(row)
  })

  // PATCH /api/deployments/:id/cancel — annuler un déploiement pending
  fastify.patch('/:id/cancel', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      UPDATE deployments SET status = 'cancelled', completed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `, [req.params.id])

    if (!rows.length) return reply.code(409).send({ error: 'Ce déploiement n\'est pas annulable (status ≠ pending)' })
    reply.send(rows[0])
  })

  // POST /api/deployments/cancel-bulk — annule plusieurs déploiements en
  // une requête (uniquement ceux en 'pending', les autres sont skip).
  // Body : { ids: [uuid, ...] }. Renvoie { cancelled, skipped }.
  // Mis avant '/:id/...' pour ne pas être capturé par la route param.
  fastify.post('/cancel-bulk', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.code(400).send({ error: 'ids requis (tableau non vide)' })
    const { rows } = await fastify.db.query(`
      UPDATE deployments SET status = 'cancelled', completed_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'pending'
      RETURNING id
    `, [ids])
    reply.send({ cancelled: rows.length, skipped: ids.length - rows.length })
  })

  // POST /api/deployments/retry-bulk — rejoue plusieurs déploiements
  // failed/cancelled. Skip ceux qui ont déjà un pending pour le même
  // couple (package, device) — évite les doublons.
  // Body : { ids: [uuid, ...] }. Renvoie { retried, skipped }.
  fastify.post('/retry-bulk', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.code(400).send({ error: 'ids requis (tableau non vide)' })
    // Un seul UPDATE conditionnel : on n'autorise que failed/cancelled, et
    // on évite les doublons via NOT EXISTS sur un pending concurrent. Plus
    // efficace qu'une boucle par-id, et garde la cohérence transactionnelle.
    const { rows } = await fastify.db.query(`
      UPDATE deployments d SET
        status = 'pending', exit_code = NULL, output = NULL,
        queued_at = now(), started_at = NULL, completed_at = NULL
      WHERE d.id = ANY($1::uuid[])
        AND d.status IN ('failed', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM deployments c
          WHERE c.package_id = d.package_id
            AND c.device_id  = d.device_id
            AND c.status     = 'pending'
            AND c.id        != d.id
        )
      RETURNING id
    `, [ids])
    reply.send({ retried: rows.length, skipped: ids.length - rows.length })
  })

  // POST /api/deployments/:id/retry — remettre en pending un déploiement failed
  fastify.post('/:id/retry', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: [existing] } = await fastify.db.query(`SELECT * FROM deployments WHERE id = $1`, [req.params.id])
    if (!existing) return reply.code(404).send({ error: 'Déploiement introuvable' })
    if (existing.status !== 'failed' && existing.status !== 'cancelled') {
      return reply.code(409).send({ error: 'Seuls les déploiements failed/cancelled sont rejouables' })
    }

    // Vérifier qu'il n'y a pas déjà un pending pour ce couple (package, device)
    const { rows: conflict } = await fastify.db.query(`
      SELECT id FROM deployments WHERE package_id = $1 AND device_id = $2 AND status = 'pending'
    `, [existing.package_id, existing.device_id])
    if (conflict.length) return reply.code(409).send({ error: 'Un déploiement pending existe déjà pour ce poste' })

    const { rows } = await fastify.db.query(`
      UPDATE deployments SET
        status = 'pending', exit_code = NULL, output = NULL,
        queued_at = now(), started_at = NULL, completed_at = NULL
      WHERE id = $1
      RETURNING *
    `, [req.params.id])

    reply.send(rows[0])
  })
}
