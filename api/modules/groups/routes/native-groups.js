import { GROUP_COLORS, resolveGroupMembers } from '../lib/groups.js'
import { logAudit } from '../../core/lib/audit.js'

// CRUD groupes natifs — coexiste avec routes/groups.js (Entra) sur le même
// prefix /api/groups. Tous les endpoints sont admin-only.

export default async function nativeGroupsRoute(fastify) {
  const auth = [fastify.authenticate, fastify.requireAdmin]

  // ─── GET /api/groups ─────────────────────────────────────────────────────
  fastify.get('/', { preHandler: auth }, async (_req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT g.id, g.name, g.description, g.color, g.source,
              g.created_at, g.created_by,
              COUNT(gm.id)::int AS member_count
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       GROUP BY g.id
       ORDER BY g.name`
    )
    reply.send(rows)
  })

  // ─── POST /api/groups ────────────────────────────────────────────────────
  fastify.post('/', { preHandler: auth }, async (req, reply) => {
    const name        = String(req.body?.name        ?? '').trim()
    const description = String(req.body?.description ?? '').trim() || null
    const color       = String(req.body?.color       ?? 'slate').trim()

    if (!name)                       return reply.code(400).send({ error: 'name requis' })
    if (!GROUP_COLORS.includes(color)) return reply.code(400).send({ error: 'Couleur invalide' })

    const byUser = fastify.getUserIdentity(req).displayName

    let row
    try {
      const r = await fastify.db.query(
        `INSERT INTO groups (name, description, color, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, name, description, color, source, created_at`,
        [name, description, color, byUser]
      )
      row = r.rows[0]
    } catch (err) {
      if (err.constraint === 'groups_name_key') {
        return reply.code(409).send({ error: 'Un groupe avec ce nom existe déjà' })
      }
      throw err
    }

    await logAudit(fastify.db, fastify.log, { action: 'group_created', byUser, target: name })
    reply.code(201).send(row)
  })

  // ─── GET /api/groups/:id ─────────────────────────────────────────────────
  fastify.get('/:id', { preHandler: auth }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT id, name, description, color, source, created_at, created_by, updated_at, updated_by
       FROM groups WHERE id = $1`,
      [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Groupe introuvable' })

    const members = await resolveGroupMembers(fastify.db, req.params.id)
    reply.send({ ...rows[0], ...members })
  })

  // ─── PATCH /api/groups/:id ───────────────────────────────────────────────
  fastify.patch('/:id', { preHandler: auth }, async (req, reply) => {
    const { rows: existing } = await fastify.db.query(
      'SELECT id, name FROM groups WHERE id = $1', [req.params.id]
    )
    if (!existing[0]) return reply.code(404).send({ error: 'Groupe introuvable' })

    const name        = req.body?.name        !== undefined ? String(req.body.name).trim()        : undefined
    const description = req.body?.description !== undefined ? String(req.body.description).trim()  : undefined
    const color       = req.body?.color       !== undefined ? String(req.body.color).trim()        : undefined

    if (name !== undefined && !name)                        return reply.code(400).send({ error: 'name ne peut pas être vide' })
    if (color !== undefined && !GROUP_COLORS.includes(color)) return reply.code(400).send({ error: 'Couleur invalide' })

    const byUser = fastify.getUserIdentity(req).displayName

    let row
    try {
      const r = await fastify.db.query(
        `UPDATE groups SET
           name        = COALESCE($1, name),
           description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END,
           color       = COALESCE($3, color),
           updated_at  = now(),
           updated_by  = $4
         WHERE id = $5
         RETURNING id, name, description, color, source, updated_at`,
        [name ?? null, description ?? null, color ?? null, byUser, req.params.id]
      )
      row = r.rows[0]
    } catch (err) {
      if (err.constraint === 'groups_name_key') {
        return reply.code(409).send({ error: 'Un groupe avec ce nom existe déjà' })
      }
      throw err
    }

    await logAudit(fastify.db, fastify.log, { action: 'group_updated', byUser, target: existing[0].name })
    reply.send(row)
  })

  // ─── DELETE /api/groups/:id ──────────────────────────────────────────────
  fastify.delete('/:id', { preHandler: auth }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      'DELETE FROM groups WHERE id = $1 RETURNING name', [req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Groupe introuvable' })

    const byUser = fastify.getUserIdentity(req).displayName
    await logAudit(fastify.db, fastify.log, { action: 'group_deleted', byUser, target: rows[0].name })
    reply.code(204).send()
  })

  // ─── POST /api/groups/:id/members ────────────────────────────────────────
  fastify.post('/:id/members', { preHandler: auth }, async (req, reply) => {
    const { rows: grp } = await fastify.db.query(
      'SELECT id, name FROM groups WHERE id = $1', [req.params.id]
    )
    if (!grp[0]) return reply.code(404).send({ error: 'Groupe introuvable' })

    const device_id = req.body?.device_id ?? null
    const user_id   = req.body?.user_id   ?? null

    if (!device_id && !user_id) {
      return reply.code(400).send({ error: 'device_id ou user_id requis' })
    }
    if (device_id && user_id) {
      return reply.code(400).send({ error: 'Fournir device_id OU user_id, pas les deux' })
    }

    const byUser = fastify.getUserIdentity(req).displayName

    let row
    try {
      const r = await fastify.db.query(
        `INSERT INTO group_members (group_id, device_id, user_id, added_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, group_id, device_id, user_id, added_at`,
        [req.params.id, device_id, user_id, byUser]
      )
      row = r.rows[0]
    } catch (err) {
      if (err.constraint === 'group_members_device_uniq' || err.constraint === 'group_members_user_uniq') {
        return reply.code(409).send({ error: 'Ce membre est déjà dans le groupe' })
      }
      if (err.constraint === 'group_members_device_id_fkey') {
        return reply.code(404).send({ error: 'Device introuvable' })
      }
      throw err
    }

    const target = device_id ? `device:${device_id}` : `user:${user_id}`
    await logAudit(fastify.db, fastify.log, { action: 'group_member_added', byUser, target: grp[0].name, details: { target } })
    reply.code(201).send(row)
  })

  // ─── DELETE /api/groups/:id/members/:mid ─────────────────────────────────
  fastify.delete('/:id/members/:mid', { preHandler: auth }, async (req, reply) => {
    const { rows: grp } = await fastify.db.query(
      'SELECT id, name FROM groups WHERE id = $1', [req.params.id]
    )
    if (!grp[0]) return reply.code(404).send({ error: 'Groupe introuvable' })

    const { rows } = await fastify.db.query(
      'DELETE FROM group_members WHERE id = $1 AND group_id = $2 RETURNING device_id, user_id',
      [req.params.mid, req.params.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Membre introuvable' })

    const byUser = fastify.getUserIdentity(req).displayName
    const target = rows[0].device_id ? `device:${rows[0].device_id}` : `user:${rows[0].user_id}`
    await logAudit(fastify.db, fastify.log, { action: 'group_member_removed', byUser, target: grp[0].name, details: { target } })
    reply.code(204).send()
  })

  // ─── POST /api/groups/import-from-entra ──────────────────────────────────
  // { entra_group_id, name?, description?, color? }
  // Crée un groupe natif source='entra' et importe ses devices depuis Graph.
  fastify.post('/import-from-entra', { preHandler: auth }, async (req, reply) => {
    const entra_group_id = String(req.body?.entra_group_id ?? '').trim()
    if (!entra_group_id) return reply.code(400).send({ error: 'entra_group_id requis' })

    const name  = String(req.body?.name        ?? '').trim()
    const desc  = String(req.body?.description ?? '').trim() || null
    const color = String(req.body?.color       ?? 'slate').trim()
    if (!name)                          return reply.code(400).send({ error: 'name requis' })
    if (!GROUP_COLORS.includes(color))  return reply.code(400).send({ error: 'Couleur invalide' })

    // Résolution des membres Entra (devices + users) en parallèle
    let hostnames, userIds
    try {
      ;[hostnames, userIds] = await Promise.all([
        fastify.graph.getGroupDeviceHostnames(entra_group_id),
        fastify.graph.getGroupUserIds(entra_group_id),
      ])
    } catch (err) { return reply.code(502).send({ error: `Graph: ${err.message}` }) }

    const { rows: devices } = await fastify.db.query(
      `SELECT id FROM devices WHERE hostname = ANY($1::text[])`, [hostnames]
    )

    const byUser = fastify.getUserIdentity(req).displayName

    // Créer le groupe natif
    let group
    try {
      const r = await fastify.db.query(
        `INSERT INTO groups (name, description, color, source, entra_group_id, created_by, updated_by)
         VALUES ($1,$2,$3,'entra',$4,$5,$5)
         RETURNING id, name, description, color, source, entra_group_id, created_at`,
        [name, desc, color, entra_group_id, byUser]
      )
      group = r.rows[0]
    } catch (err) {
      if (err.constraint === 'groups_name_key') return reply.code(409).send({ error: 'Un groupe avec ce nom existe déjà' })
      if (err.constraint === 'groups_entra_group_id_uniq') {
        const { rows: [existing] } = await fastify.db.query(
          'SELECT name FROM groups WHERE entra_group_id = $1', [entra_group_id]
        )
        return reply.code(409).send({ error: `Ce groupe Entra est déjà importé sous le nom "${existing?.name ?? '?'}"` })
      }
      throw err
    }

    // Importer devices
    for (const d of devices) {
      await fastify.db.query(
        `INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [group.id, d.id, byUser]
      )
    }
    // Importer users
    for (const uid of userIds) {
      await fastify.db.query(
        `INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [group.id, uid, byUser]
      )
    }

    await logAudit(fastify.db, fastify.log, {
      action: 'group_imported_from_entra',
      byUser,
      target: name,
      details: { entra_group_id, devices_imported: devices.length, users_imported: userIds.length, unmatched: hostnames.length - devices.length },
    })

    reply.code(201).send({
      ...group,
      devices_imported: devices.length,
      users_imported: userIds.length,
      unmatched: hostnames.length - devices.length,
    })
  })

  // ─── POST /api/groups/:id/sync-from-entra ────────────────────────────────
  // Full-replace des membres devices + users depuis Entra.
  // Requiert que le groupe ait entra_group_id défini.
  fastify.post('/:id/sync-from-entra', { preHandler: auth }, async (req, reply) => {
    const { rows: [grp] } = await fastify.db.query(
      'SELECT id, name, entra_group_id FROM groups WHERE id = $1', [req.params.id]
    )
    if (!grp) return reply.code(404).send({ error: 'Groupe introuvable' })
    if (!grp.entra_group_id) return reply.code(409).send({ error: 'Ce groupe n\'est pas lié à un groupe Entra' })

    let hostnames, userIds
    try {
      ;[hostnames, userIds] = await Promise.all([
        fastify.graph.getGroupDeviceHostnames(grp.entra_group_id),
        fastify.graph.getGroupUserIds(grp.entra_group_id),
      ])
    } catch (err) { return reply.code(502).send({ error: `Graph: ${err.message}` }) }

    const { rows: devices } = await fastify.db.query(
      `SELECT id FROM devices WHERE hostname = ANY($1::text[])`, [hostnames]
    )
    const deviceIds = devices.map(r => r.id)
    const byUser = fastify.getUserIdentity(req).displayName

    // Full-replace devices + users dans une transaction
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM group_members WHERE group_id = $1 AND device_id IS NOT NULL`, [grp.id])
      await client.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id   IS NOT NULL`, [grp.id])
      for (const id of deviceIds) {
        await client.query(
          `INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [grp.id, id, byUser]
        )
      }
      for (const uid of userIds) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [grp.id, uid, byUser]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    await logAudit(fastify.db, fastify.log, {
      action: 'group_synced_from_entra',
      byUser,
      target: grp.name,
      details: { devices_synced: deviceIds.length, users_synced: userIds.length, unmatched: hostnames.length - deviceIds.length },
    })

    reply.send({ devices_synced: deviceIds.length, users_synced: userIds.length, unmatched: hostnames.length - deviceIds.length })
  })

  // ─── POST /api/groups/:id/detach-entra ───────────────────────────────────
  // Détache le groupe de son groupe Entra source : source → 'native',
  // entra_group_id → NULL. Les membres existants sont conservés.
  fastify.post('/:id/detach-entra', { preHandler: auth }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `UPDATE groups SET source = 'native', entra_group_id = NULL, updated_at = now(), updated_by = $2
       WHERE id = $1 AND entra_group_id IS NOT NULL
       RETURNING id, name`,
      [req.params.id, fastify.getUserIdentity(req).displayName]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Groupe introuvable ou déjà détaché' })

    await logAudit(fastify.db, fastify.log, {
      action: 'group_detached_from_entra',
      byUser: fastify.getUserIdentity(req).displayName,
      target: rows[0].name,
    })
    reply.send({ ok: true })
  })
}
