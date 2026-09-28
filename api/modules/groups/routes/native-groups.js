import { GROUP_COLORS, resolveGroupMembers } from '../lib/groups.js'
import { logAudit } from '../../core/lib/audit.js'

// CRUD groupes natifs — coexiste avec routes/groups.js (Entra) sur le même
// prefix /api/groups. Tous les endpoints sont admin-only.

const MAX_IMPORT_DEPTH = 20

// Vrai si rattacher childId comme membre de parentId créerait un cycle, i.e.
// si parentId est déjà atteignable en descendant depuis childId.
async function wouldCreateCycle(db, parentId, childId, _seen = new Set()) {
  if (childId === parentId) return true
  if (_seen.has(childId)) return false
  _seen.add(childId)
  const { rows } = await db.query(
    'SELECT member_group_id FROM group_members WHERE group_id = $1 AND member_group_id IS NOT NULL', [childId]
  )
  for (const r of rows) {
    if (await wouldCreateCycle(db, parentId, r.member_group_id, _seen)) return true
  }
  return false
}

// Crée un groupe Opale source='entra'. Gère la collision de nom
// (groups_name_key) en suffixant avec un fragment de l'id Entra.
// Appelé exclusivement dans une transaction (importEntraTree) : on isole chaque
// tentative d'INSERT par un SAVEPOINT, car une erreur Postgres avorte sinon
// toute la transaction.
async function createEntraGroup(db, { name, description, color, entraGroupId, byUser }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const tryName = (attempt === 0
      ? name
      : `${name} [${entraGroupId.slice(0, 6)}${attempt > 1 ? '-' + attempt : ''}]`).slice(0, 200)
    await db.query('SAVEPOINT cg')
    try {
      const { rows: [g] } = await db.query(
        `INSERT INTO groups (name, description, color, source, entra_group_id, created_by, updated_by)
         VALUES ($1,$2,$3,'entra',$4,$5,$5) RETURNING id`,
        [tryName, description, color, entraGroupId, byUser]
      )
      await db.query('RELEASE SAVEPOINT cg')
      return g
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT cg')
      if (err.constraint === 'groups_name_key') continue // collision de nom → suffixe
      if (err.constraint === 'groups_entra_group_id_uniq') {     // créé en concurrence
        const { rows: [g] } = await db.query('SELECT id FROM groups WHERE entra_group_id = $1', [entraGroupId])
        if (g) return g
      }
      throw err
    }
  }
  throw new Error(`Nom de groupe importé impossible à attribuer (collisions): ${name}`)
}

// Importe / resynchronise un groupe Entra ET ses sous-groupes, récursivement.
//   mode 'import' : ne touche pas les membres d'un groupe déjà existant (réutilisé + lié).
//   mode 'sync'   : full-replace des membres directs de chaque groupe visité.
// seen : Map<entraGroupId, opaleGroupId> (anti-cycle + dédup). stats : compteurs.
// Retourne l'id Opale du groupe (racine de cet appel) ou null si profondeur dépassée.
async function importEntraTree(fastify, db, opts) {
  const { entraGroupId, name, description = null, color = 'slate', byUser, recursive, mode, seen, stats, depth = 0 } = opts
  if (seen.has(entraGroupId)) return seen.get(entraGroupId)
  if (depth > MAX_IMPORT_DEPTH) { stats.depth_truncated = true; return null }

  // find-or-create par entra_group_id
  let { rows: [grp] } = await db.query('SELECT id FROM groups WHERE entra_group_id = $1', [entraGroupId])
  const created = !grp
  if (!grp) {
    grp = await createEntraGroup(db, { name: name || entraGroupId, description, color, entraGroupId, byUser })
    stats.groups_created++
  }
  seen.set(entraGroupId, grp.id)

  // Membres directs depuis Graph (devices + users + sous-groupes directs)
  let hostnames = [], userIds = [], nested = []
  try {
    ;[hostnames, userIds, nested] = await Promise.all([
      fastify.graph.getGroupDeviceHostnames(entraGroupId),
      fastify.graph.getGroupUserIds(entraGroupId),
      recursive ? fastify.graph.getGroupNestedGroups(entraGroupId) : Promise.resolve([]),
    ])
  } catch (err) {
    throw new Error(`Graph (${entraGroupId}): ${err.message}`)
  }

  // On (re)peuple les membres directs si le groupe est neuf, ou en mode sync.
  if (created || mode === 'sync') {
    const { rows: devs } = await db.query(
      'SELECT id FROM devices WHERE hostname = ANY($1::text[])', [hostnames]
    )
    if (mode === 'sync') {
      // Full-replace des devices/users directs. Les liens vers des sous-groupes
      // ne sont remplacés que s'ils viennent d'Entra ET qu'on resynchronise
      // les sous-groupes : un sous-groupe natif ajouté à la main reste lié.
      await db.query(
        `DELETE FROM group_members gm
         WHERE gm.group_id = $1
           AND (gm.member_group_id IS NULL
                OR ($2 AND EXISTS (SELECT 1 FROM groups g WHERE g.id = gm.member_group_id AND g.source = 'entra')))`,
        [grp.id, recursive]
      )
    }
    for (const d of devs) {
      await db.query('INSERT INTO group_members (group_id, device_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [grp.id, d.id, byUser])
    }
    for (const uid of userIds) {
      await db.query('INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [grp.id, uid, byUser])
    }
    stats.devices   += devs.length
    stats.users     += userIds.length
    stats.unmatched += (hostnames.length - devs.length)
  }

  // Sous-groupes : recursion + lien parent → enfant
  for (const ng of nested) {
    const childId = await importEntraTree(fastify, db, {
      entraGroupId: ng.id, name: ng.displayName || ng.id, description: ng.description,
      color, byUser, recursive, mode, seen, stats, depth: depth + 1,
    })
    if (childId) {
      await db.query(
        'INSERT INTO group_members (group_id, member_group_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [grp.id, childId, byUser]
      )
    }
  }

  return grp.id
}

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

  // ─── GET /api/groups/overlaps ────────────────────────────────────────────
  // Pour le diagramme : pour chaque paire de groupes partageant ≥1 membre
  // (user OU device), le nombre de membres communs. Le front en dérive
  // l'overlap visuel (shared > 0) et l'inclusion (shared == member_count du
  // plus petit). Déclaré AVANT /:id pour ne pas être pris pour un id.
  fastify.get('/overlaps', { preHandler: auth }, async (_req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT a.group_id AS a, b.group_id AS b, COUNT(*)::int AS shared
      FROM group_members a
      JOIN group_members b
        ON a.group_id < b.group_id
       AND ( (a.user_id   IS NOT NULL AND a.user_id   = b.user_id)
          OR (a.device_id IS NOT NULL AND a.device_id = b.device_id) )
      GROUP BY a.group_id, b.group_id
    `)
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

    const device_id       = req.body?.device_id       ?? null
    const user_id         = req.body?.user_id         ?? null
    const member_group_id = req.body?.member_group_id ?? null

    const provided = [device_id, user_id, member_group_id].filter(Boolean).length
    if (provided === 0) return reply.code(400).send({ error: 'device_id, user_id ou member_group_id requis' })
    if (provided > 1)   return reply.code(400).send({ error: 'Fournir un seul type de membre' })

    // Groupe-dans-groupe : interdit le cycle (direct via CHECK, indirect ici).
    if (member_group_id) {
      if (member_group_id === req.params.id) return reply.code(400).send({ error: 'Un groupe ne peut pas se contenir lui-même' })
      const { rows: tgt } = await fastify.db.query('SELECT id FROM groups WHERE id = $1', [member_group_id])
      if (!tgt[0]) return reply.code(404).send({ error: 'Groupe membre introuvable' })
      if (await wouldCreateCycle(fastify.db, req.params.id, member_group_id)) {
        return reply.code(400).send({ error: 'Ajout refusé : créerait un cycle de groupes' })
      }
    }

    const byUser = fastify.getUserIdentity(req).displayName

    let row
    try {
      const r = await fastify.db.query(
        `INSERT INTO group_members (group_id, device_id, user_id, member_group_id, added_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, group_id, device_id, user_id, member_group_id, added_at`,
        [req.params.id, device_id, user_id, member_group_id, byUser]
      )
      row = r.rows[0]
    } catch (err) {
      if (err.constraint === 'group_members_device_uniq' || err.constraint === 'group_members_user_uniq' || err.constraint === 'group_members_group_uniq') {
        return reply.code(409).send({ error: 'Ce membre est déjà dans le groupe' })
      }
      if (err.constraint === 'group_members_device_id_fkey') {
        return reply.code(404).send({ error: 'Device introuvable' })
      }
      throw err
    }

    const target = device_id ? `device:${device_id}` : member_group_id ? `group:${member_group_id}` : `user:${user_id}`
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
    const recursive = req.body?.recursive !== false   // défaut : importe aussi les sous-groupes
    if (!name)                          return reply.code(400).send({ error: 'name requis' })
    if (!GROUP_COLORS.includes(color))  return reply.code(400).send({ error: 'Couleur invalide' })

    // Racine déjà importée ?
    const { rows: [dup] } = await fastify.db.query(
      'SELECT name FROM groups WHERE entra_group_id = $1', [entra_group_id]
    )
    if (dup) return reply.code(409).send({ error: `Ce groupe Entra est déjà importé sous le nom "${dup.name}"` })

    const byUser = fastify.getUserIdentity(req).displayName
    const seen  = new Map()
    const stats = { groups_created: 0, devices: 0, users: 0, unmatched: 0 }

    const client = await fastify.db.connect()
    let rootId
    try {
      await client.query('BEGIN')
      rootId = await importEntraTree(fastify, client, {
        entraGroupId: entra_group_id, name, description: desc, color, byUser, recursive, mode: 'import', seen, stats,
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (/^Graph/.test(err.message)) return reply.code(502).send({ error: err.message })
      if (err.constraint === 'groups_name_key') return reply.code(409).send({ error: 'Un groupe avec ce nom existe déjà' })
      throw err
    } finally {
      client.release()
    }

    const { rows: [group] } = await fastify.db.query(
      'SELECT id, name, description, color, source, entra_group_id, created_at FROM groups WHERE id = $1', [rootId]
    )
    await logAudit(fastify.db, fastify.log, {
      action: 'group_imported_from_entra', byUser, target: name,
      details: { entra_group_id, recursive, ...stats },
    })
    reply.code(201).send({
      ...group,
      devices_imported: stats.devices,
      users_imported:   stats.users,
      nested_groups:    Math.max(0, seen.size - 1),
      unmatched:        stats.unmatched,
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

    const recursive = req.body?.recursive !== false   // défaut : resync aussi les sous-groupes
    const byUser = fastify.getUserIdentity(req).displayName
    const seen  = new Map()
    const stats = { groups_created: 0, devices: 0, users: 0, unmatched: 0 }

    // Full-replace récursif (groupe + sous-groupes) dans une transaction.
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await importEntraTree(fastify, client, {
        entraGroupId: grp.entra_group_id, name: grp.name, byUser, recursive, mode: 'sync', seen, stats,
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (/^Graph/.test(err.message)) return reply.code(502).send({ error: err.message })
      throw err
    } finally {
      client.release()
    }

    await logAudit(fastify.db, fastify.log, {
      action: 'group_synced_from_entra', byUser, target: grp.name,
      details: { recursive, ...stats },
    })
    reply.send({
      devices_synced: stats.devices,
      users_synced:   stats.users,
      nested_groups:  Math.max(0, seen.size - 1),   // sous-groupes resynchronisés (créés ou non)
      unmatched:      stats.unmatched,
    })
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
