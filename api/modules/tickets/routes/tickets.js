import multipart from '@fastify/multipart'
import {
  syncRequester, addInvolvedUser, removeUserFromTicket,
  addDeviceToTicket, removeDeviceFromTicket,
  loadRelatedUsersFor, loadRelatedDevicesFor,
  mergeTicketInto,
} from '../lib/relations.js'
import {
  saveAttachmentStream, openAttachment, deleteAttachmentFile, contentDisposition,
} from '../lib/attachments.js'
import { generateSuggestion } from '../lib/assistant.js'

// Taille max d'une pièce jointe : 25 Mo.
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

// Couleurs autorisées pour les tags : palette fermée alignée avec le front.
const TAG_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet', 'pink', 'teal']
const PRIORITIES = ['low', 'normal', 'high', 'critical']
const USER_ROLES = ['requester', 'involved']
// Messages internes à l'équipe IT : jamais renvoyés à un non-admin (requester
// ou assignee non-admin), ni cherchables par lui via ?q=.
const INTERNAL_MESSAGE_TYPES = ['internal_note', 'ai_suggestion']

// Valeur fournie dans un body (null / '' = absent, cf. `x || null` à l'INSERT).
function isSet(v) {
  return v !== undefined && v !== null && v !== ''
}

// Un non-admin ne peut rattacher à un ticket qu'un poste qui lui est assigné.
// id::text : un device_id non-UUID ne doit pas lever d'erreur SQL (→ 403).
async function isOwnDevice(db, deviceId, entraId) {
  const { rows } = await db.query(
    'SELECT 1 FROM devices WHERE id::text = $1 AND assigned_user_id = $2',
    [String(deviceId), entraId]
  )
  return rows.length > 0
}

function parseCsv(v) {
  if (!v) return null
  return String(v).split(',').map(s => s.trim()).filter(Boolean)
}

function parseDate(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Charge les tags pour une liste d'ids de tickets, retourne une Map(ticketId → tags[])
async function loadTagsFor(db, ticketIds) {
  if (!ticketIds.length) return new Map()
  const { rows } = await db.query(`
    SELECT tt.ticket_id, g.id, g.name, g.color
    FROM ticket_tags tt
    JOIN tags g ON g.id = tt.tag_id
    WHERE tt.ticket_id = ANY($1)
    ORDER BY g.name
  `, [ticketIds])
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.ticket_id)) map.set(r.ticket_id, [])
    map.get(r.ticket_id).push({ id: r.id, name: r.name, color: r.color })
  }
  return map
}

// Vérifie l'accès à un ticket : admin OU requester (user_id) OU assignee
// (assigned_to_entra_id). Renvoie l'identité résolue + le flag isAdmin (+ la
// ligne ticket user_id/assigned_to_entra_id) pour éviter une seconde requête.
// Si pas d'accès, répond 403/404 et renvoie null.
async function checkTicketAccess(fastify, request, reply, ticketId) {
  const { rows } = await fastify.db.query(
    'SELECT user_id, assigned_to_entra_id FROM tickets WHERE id = $1', [ticketId]
  )
  if (!rows.length) { reply.code(404).send({ error: 'Ticket introuvable' }); return null }
  const isAdmin = await fastify.isAdmin(request)
  const identity = fastify.getUserIdentity(request)
  if (!isAdmin
      && rows[0].user_id !== identity.entraId
      && rows[0].assigned_to_entra_id !== identity.entraId) {
    reply.code(403).send({ error: 'Non autorisé' })
    return null
  }
  return { isAdmin, ...identity, ticket: rows[0] }
}

export default async function ticketsRoute(fastify) {

  // Multipart pour l'upload de pièces jointes. Enregistré au scope de ce
  // plugin (suffisant : seules les routes attachments l'utilisent). La
  // limite fileSize coupe le stream au-delà de 25 Mo → on détecte via
  // file.truncated côté handler pour répondre 413.
  await fastify.register(multipart, {
    limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Routes statiques — déclarées AVANT /:id pour ne pas être confondues
  // avec un identifiant par Fastify.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/tickets/count — tickets ouverts non encore pris en charge (badge sidebar)
  // Admin-only : un non-admin ne s'auto-assignerait pas de tickets non assignés.
  fastify.get('/count', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT COUNT(*)::int AS open
       FROM tickets
       WHERE status = 'open' AND assigned_to_entra_id IS NULL`
    )
    reply.send(rows[0])
  })

  // GET /api/tickets/tags
  fastify.get('/tags', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      'SELECT id, name, color, created_at FROM tags ORDER BY name'
    )
    reply.send(rows)
  })

  // POST /api/tickets/tags  { name, color? }
  fastify.post('/tags', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const name  = String(req.body?.name || '').trim()
    const color = String(req.body?.color || 'slate').trim()
    if (!name)                          return reply.code(400).send({ error: 'Nom requis' })
    if (!TAG_COLORS.includes(color))    return reply.code(400).send({ error: 'Couleur invalide' })
    if (name.length > 40)               return reply.code(400).send({ error: 'Nom trop long (40 max)' })

    try {
      const { rows } = await fastify.db.query(
        'INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at',
        [name, color]
      )
      reply.code(201).send(rows[0])
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'Ce tag existe déjà' })
      throw err
    }
  })

  // DELETE /api/tickets/tags/:id  (cascade vers ticket_tags)
  fastify.delete('/tags/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rowCount } = await fastify.db.query('DELETE FROM tags WHERE id = $1', [req.params.id])
    if (!rowCount) return reply.code(404).send({ error: 'Tag introuvable' })
    reply.code(204).send()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Tickets
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/tickets
  // Paramètres : status, device_id, q, priority (csv), assigned_to (entra_id|me|unassigned),
  //              tag (csv tag_ids, AND), created_from/created_to (ISO), is_auto, limit, offset
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const {
      status, device_id, q, priority, assigned_to, tag,
      created_from, created_to, is_auto,
    } = req.query

    const limit  = Math.min(parseInt(req.query.limit  ?? 50, 10) || 50, 200)
    const offset = Math.max(parseInt(req.query.offset ?? 0,  10) || 0,   0)

    const conds = []
    const params = []
    let i = 1

    // ACL : un non-admin ne voit que ses propres tickets (requester ou assignee).
    const isAdmin = await fastify.isAdmin(req)
    if (!isAdmin) {
      const { entraId } = fastify.getUserIdentity(req)
      conds.push(`(t.user_id = $${i} OR t.assigned_to_entra_id = $${i})`)
      params.push(entraId); i++
    }

    // status='closed' (archives) doit être OPT-IN : sinon les tickets clos
    // pollueraient le tab "Tous" et l'UX serait identique à avant. Quand
    // aucun status n'est fourni, on exclut implicitement les clos.
    if (status === 'closed') {
      conds.push(`t.status = 'closed'`)
    } else if (status) {
      conds.push(`t.status = $${i++}`); params.push(status)
    } else {
      conds.push(`t.status <> 'closed'`)
    }
    if (device_id) { conds.push(`t.device_id = $${i++}`); params.push(device_id) }
    if (q) {
      // Recherche : titre, description, messages (commentaires/résolutions/
      // notes internes), ET personnes concernées (requester + involved,
      // par display_name ou email). Tous les sous-critères en OR sur le
      // même paramètre $i pour rester un seul slot ; $i+1 = types de
      // messages exclus (un non-admin ne cherche pas dans les notes
      // internes / suggestions IA : sinon oracle sur leur contenu).
      const hiddenTypes = isAdmin ? ['system'] : ['system', ...INTERNAL_MESSAGE_TYPES]
      conds.push(`(
        t.title ILIKE $${i} OR t.description ILIKE $${i}
        OR EXISTS (
          SELECT 1 FROM ticket_messages tm
          WHERE tm.ticket_id = t.id
            AND tm.type <> ALL($${i + 1}::text[])
            AND tm.content ILIKE $${i}
        )
        OR EXISTS (
          SELECT 1 FROM ticket_users tu
          JOIN users_cache u ON u.entra_id = tu.user_entra_id
          WHERE tu.ticket_id = t.id
            AND (u.display_name ILIKE $${i} OR u.email ILIKE $${i})
        )
      )`)
      params.push(`%${q}%`, hiddenTypes); i += 2
    }
    if (is_auto === 'true' || is_auto === 'false') {
      conds.push(`t.is_auto = $${i++}`); params.push(is_auto === 'true')
    }

    const prios = parseCsv(priority)?.filter(p => PRIORITIES.includes(p))
    if (prios?.length) { conds.push(`t.priority = ANY($${i++})`); params.push(prios) }

    if (assigned_to === 'me') {
      const { entraId } = fastify.getUserIdentity(req)
      conds.push(`t.assigned_to_entra_id = $${i++}`); params.push(entraId)
    } else if (assigned_to === 'unassigned') {
      conds.push(`t.assigned_to_entra_id IS NULL`)
    } else if (assigned_to) {
      conds.push(`t.assigned_to_entra_id = $${i++}`); params.push(assigned_to)
    }

    const tagIds = parseCsv(tag)
    if (tagIds?.length) {
      // AND : ticket doit posséder TOUS les tags listés
      conds.push(`(
        SELECT COUNT(*) FROM ticket_tags tt
        WHERE tt.ticket_id = t.id AND tt.tag_id = ANY($${i})
      ) = $${i + 1}`)
      params.push(tagIds, tagIds.length)
      i += 2
    }

    const fromIso = parseDate(created_from)
    const toIso   = parseDate(created_to)
    if (fromIso) { conds.push(`t.created_at >= $${i++}`); params.push(fromIso) }
    if (toIso)   { conds.push(`t.created_at <= $${i++}`); params.push(toIso) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const { displayName: meName } = fastify.getUserIdentity(req)
    params.push(meName, limit, offset)
    const meIdx = i

    // awaiting_reply : ticket open/in_progress dont le dernier message non-system n'est pas de moi
    const { rows } = await fastify.db.query(`
      SELECT t.*, d.hostname, d.assigned_user_id AS assigned_user,
             u.display_name AS requester_name, u.email AS requester_email,
             CASE
               WHEN t.status IN ('open','in_progress')
                AND lm.author IS NOT NULL
                AND lm.author <> $${meIdx}
               THEN true ELSE false
             END AS awaiting_reply
      FROM tickets t
      LEFT JOIN devices d     ON d.id = t.device_id
      LEFT JOIN users_cache u ON u.entra_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT author FROM ticket_messages
        WHERE ticket_id = t.id AND type <> 'system'
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      ${where}
      -- Tri stable par priorité opérationnelle : in_progress en premier
      -- (sur quoi je bosse maintenant), puis open (file d'attente), puis
      -- resolved (consultatif), puis closed (archives). Au sein de chaque
      -- bucket status, les tickets critiques / high remontent en haut.
      -- Sur un filtre status précis le CASE status est neutre — le tri
      -- par priorité puis par updated_at reste effectif.
      ORDER BY
        CASE t.status
          WHEN 'in_progress' THEN 1
          WHEN 'open'        THEN 2
          WHEN 'resolved'    THEN 3
          WHEN 'closed'      THEN 4
          ELSE 9
        END,
        CASE t.priority
          WHEN 'critical' THEN 1
          WHEN 'high'     THEN 2
          WHEN 'normal'   THEN 3
          WHEN 'low'      THEN 4
          ELSE 5
        END,
        t.updated_at DESC NULLS LAST, t.created_at DESC
      LIMIT $${i + 1} OFFSET $${i + 2}
    `, params)

    const tagMap = await loadTagsFor(fastify.db, rows.map(r => r.id))
    for (const r of rows) r.tags = tagMap.get(r.id) || []

    reply.send(rows)
  })

  // POST /api/tickets
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const {
      title, description, priority = 'normal', device_id,
      source = 'manual',
      assigned_to_entra_id, assigned_to_name,
      user_id,
      tag_ids,
    } = req.body || {}
    if (!title) return reply.code(400).send({ error: 'Titre requis' })

    const { entraId, displayName } = fastify.getUserIdentity(req)

    // Non-admin : ticket pour lui-même uniquement (pas d'assignation, pas de
    // tags, pas de demandeur tiers) et seulement un poste qui lui est assigné.
    if (!(await fastify.isAdmin(req))) {
      if (isSet(assigned_to_entra_id) || isSet(assigned_to_name)
          || (Array.isArray(tag_ids) && tag_ids.length)) {
        return reply.code(403).send({ error: 'Assignation et tags réservés aux admins' })
      }
      if (isSet(user_id) && user_id !== entraId) {
        return reply.code(403).send({ error: 'Demandeur tiers réservé aux admins' })
      }
      if (isSet(device_id) && !(await isOwnDevice(fastify.db, device_id, entraId))) {
        return reply.code(403).send({ error: 'Poste non assigné à cet utilisateur' })
      }
    }

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`
        INSERT INTO tickets
          (title, description, priority, device_id, user_id, source, is_auto,
           created_by_entra_id, created_by_name,
           assigned_to_entra_id, assigned_to_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        title, description || null, priority, device_id || null, user_id || null, source,
        source === 'auto', entraId, displayName,
        assigned_to_entra_id || null, assigned_to_name || null,
      ])
      const tk = rows[0]

      if (Array.isArray(tag_ids) && tag_ids.length) {
        const values = tag_ids.map((_, idx) => `($1, $${idx + 2})`).join(',')
        await client.query(
          `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [tk.id, ...tag_ids]
        )
      }

      // Phase 2 : peuple les tables M2M en cohérence avec les colonnes
      // tickets.user_id / device_id qu'on vient d'écrire.
      if (tk.user_id)   await syncRequester(client, tk.id, tk.user_id)
      if (tk.device_id) await addDeviceToTicket(client, tk.id, tk.device_id)

      await client.query('COMMIT')

      // Re-fetch avec le requester pour cohérence avec GET
      if (tk.user_id) {
        const { rows: ur } = await fastify.db.query(
          'SELECT display_name, email FROM users_cache WHERE entra_id = $1',
          [tk.user_id]
        )
        if (ur[0]) { tk.requester_name = ur[0].display_name; tk.requester_email = ur[0].email }
      }

      const tagMap = await loadTagsFor(fastify.db, [tk.id])
      tk.tags = tagMap.get(tk.id) || []
      reply.code(201).send(tk)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // GET /api/tickets/:id — admin OU requester OU assignee
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { displayName: meName } = acl
    const { rows: tRows } = await fastify.db.query(`
      SELECT t.*, d.hostname, d.assigned_user_id AS assigned_user,
             u.display_name AS requester_name, u.email AS requester_email,
             CASE
               WHEN t.status IN ('open','in_progress')
                AND lm.author IS NOT NULL
                AND lm.author <> $2
               THEN true ELSE false
             END AS awaiting_reply,
             EXISTS (
               SELECT 1 FROM email_thread_mapping etm
               WHERE etm.ticket_id = t.id AND etm.direction = 'inbound'
             ) AS has_inbound_mail
      FROM tickets t
      LEFT JOIN devices d     ON d.id = t.device_id
      LEFT JOIN users_cache u ON u.entra_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT author FROM ticket_messages
        WHERE ticket_id = t.id AND type <> 'system'
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      WHERE t.id = $1
    `, [req.params.id, meName])

    if (!tRows.length) return reply.code(404).send({ error: 'Ticket introuvable' })

    // Non-admin (requester / assignee) : jamais les notes internes ni les
    // suggestions IA.
    const { rows: msgs } = await fastify.db.query(`
      SELECT * FROM ticket_messages
      WHERE ticket_id = $1 AND ($2::boolean OR type <> ALL($3::text[]))
      ORDER BY created_at ASC
    `, [req.params.id, acl.isAdmin, INTERNAL_MESSAGE_TYPES])

    const tagMap = await loadTagsFor(fastify.db, [req.params.id])
    const tk = tRows[0]
    tk.tags = tagMap.get(tk.id) || []
    tk.messages = msgs

    // Phase 2 : exposer les relations M2M complètes (le front affichera des
    // listes éditables au lieu de juste tk.user_id + tk.device_id).
    const [usersMap, devicesMap, attachments] = await Promise.all([
      loadRelatedUsersFor(fastify.db, [tk.id]),
      loadRelatedDevicesFor(fastify.db, [tk.id]),
      fastify.db.query(
        `SELECT id, filename, mime_type, size_bytes, uploaded_by_name, created_at
         FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ),
    ])
    tk.related_users   = usersMap.get(tk.id) || []
    tk.related_devices = devicesMap.get(tk.id) || []
    tk.attachments     = attachments.rows

    reply.send(tk)
  })

  // PATCH /api/tickets/:id — admin OU requester OU assignee
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { status, priority, assigned_to_entra_id, assigned_to_name, user_id, device_id } = req.body || {}
    const { displayName } = acl

    // Non-admin : ni réassignation ni changement de demandeur ; seul le
    // requester peut (dé)rattacher un poste, et uniquement un poste à lui.
    if (!acl.isAdmin) {
      if (assigned_to_entra_id !== undefined || assigned_to_name !== undefined || user_id !== undefined) {
        return reply.code(403).send({ error: 'Assignation et demandeur modifiables par un admin uniquement' })
      }
      if (device_id !== undefined) {
        if (acl.ticket.user_id !== acl.entraId
            || (device_id && !(await isOwnDevice(fastify.db, device_id, acl.entraId)))) {
          return reply.code(403).send({ error: 'Poste non assigné à cet utilisateur' })
        }
      }
    }

    const fields = []
    const params = []
    let i = 1

    if (status !== undefined)               { fields.push(`status = $${i++}`);               params.push(status) }
    if (priority !== undefined)             { fields.push(`priority = $${i++}`);             params.push(priority) }
    if (assigned_to_entra_id !== undefined) { fields.push(`assigned_to_entra_id = $${i++}`); params.push(assigned_to_entra_id) }
    if (assigned_to_name !== undefined)     { fields.push(`assigned_to_name = $${i++}`);     params.push(assigned_to_name) }
    if (user_id !== undefined)              { fields.push(`user_id = $${i++}`);              params.push(user_id) }
    if (device_id !== undefined)            { fields.push(`device_id = $${i++}`);            params.push(device_id) }
    if (status === 'resolved')              { fields.push(`resolved_at = $${i++}`);          params.push(new Date()) }

    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      const { rows: existing } = await client.query(
        `SELECT status FROM tickets WHERE id = $1 FOR UPDATE`, [req.params.id]
      )
      if (!existing.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Ticket introuvable' }) }

      params.push(req.params.id)
      const { rows } = await client.query(`
        UPDATE tickets SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${i} RETURNING *
      `, params)

      // Phase 2 : sync M2M si user_id / device_id changent. Pour device_id,
      // on ajoute simplement à ticket_devices (sans retirer les autres) :
      // c'est la sémantique "+1 device concerné" plutôt que "remplace".
      if (user_id !== undefined)   await syncRequester(client, req.params.id, user_id || null)
      if (device_id !== undefined && device_id) await addDeviceToTicket(client, req.params.id, device_id)

      // Message système si changement de statut
      if (status && status !== existing[0].status) {
        const label = status === 'resolved'    ? 'Ticket résolu'
                    : status === 'in_progress' ? 'Ticket pris en charge'
                    : status === 'open'        ? 'Ticket réouvert'
                    : status

        await client.query(`
          INSERT INTO ticket_messages (ticket_id, type, author, content)
          VALUES ($1, 'system', $2, $3)
        `, [req.params.id, displayName, label])
      }

      await client.query('COMMIT')
      reply.send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  // POST /api/tickets/:id/messages — admin OU requester OU assignee
  // Phase 1c — par défaut, un message saisi depuis l'UI est une *note interne*
  // (type='internal_note'). L'outbox mail (qui filtre type='comment') ne le
  // picke pas. Pour envoyer effectivement le message par mail au requester,
  // l'admin doit ensuite cliquer "Envoyer par mail" sur la note → route
  // /messages/:msgId/send-by-mail ci-dessous, qui flip type='comment' +
  // email_sent_at=NULL.
  // email_sent_at = now() à la création évite que l'outbox repere la note
  // interne même si on oubliait le filtre type côté worker.
  fastify.post('/:id/messages', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    // Défaut : note interne pour un admin, commentaire pour un non-admin
    // (qui ne voit pas les notes internes).
    const { content, type = acl.isAdmin ? 'internal_note' : 'comment' } = req.body || {}
    if (!content) return reply.code(400).send({ error: 'Contenu requis' })
    if (!['internal_note', 'comment', 'system', 'resolution'].includes(type)) {
      return reply.code(400).send({ error: 'Type invalide' })
    }
    // Messages system / resolution / note interne : réservés aux admins.
    if (!acl.isAdmin && type !== 'comment') {
      return reply.code(403).send({ error: 'Type de message réservé aux admins' })
    }

    const { displayName } = acl
    const { rows } = await fastify.db.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
      VALUES ($1, $2, $3, $4, now())
      RETURNING *
    `, [req.params.id, type, displayName, content])

    await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(201).send(rows[0])
  })

  // POST /api/tickets/:id/messages/:msgId/send-by-mail
  // Convertit une note interne en message à envoyer par mail. L'admin a
  // d'abord saisi le texte en mode interne (sans envoi), puis décide de
  // l'envoyer en cliquant sur ce bouton. On flip :
  //   type = 'comment' (l'outbox filtre sur type='comment')
  //   email_sent_at = NULL (l'outbox picke email_sent_at IS NULL)
  // L'envoi effectif se fait au prochain tick du worker outbound (~10s).
  // Garde-fous : ticket doit avoir un mapping inbound (sinon pas de
  // destinataire), et le message doit être encore une note interne (re-clic
  // = idempotent no-op, on retourne tel quel).
  // Admin-only : envoyer une note interne au requester est une décision de
  // l'équipe IT (un requester ne doit jamais recevoir les notes internes).
  fastify.post('/:id/messages/:msgId/send-by-mail',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
      if (!acl) return

      const { rows: msgRows } = await fastify.db.query(
        `SELECT id, type, email_sent_at FROM ticket_messages WHERE id = $1 AND ticket_id = $2`,
        [req.params.msgId, req.params.id]
      )
      if (!msgRows.length) return reply.code(404).send({ error: 'Message introuvable' })
      if (msgRows[0].type !== 'internal_note') {
        // Déjà converti (ou message inbound, ou système). Idempotent : retour
        // tel quel pour ne pas confondre le front si double-clic.
        return reply.send(msgRows[0])
      }

      const { rows: mapRows } = await fastify.db.query(
        `SELECT 1 FROM email_thread_mapping
         WHERE ticket_id = $1 AND direction = 'inbound' LIMIT 1`,
        [req.params.id]
      )
      if (!mapRows.length) {
        return reply.code(409).send({ error: 'Ticket sans origine mail, envoi impossible' })
      }

      const { rows } = await fastify.db.query(`
        UPDATE ticket_messages
        SET type = 'comment', email_sent_at = NULL
        WHERE id = $1
        RETURNING *
      `, [req.params.msgId])
      await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
      reply.send(rows[0])
    })

  // POST /api/tickets/:id/messages/:msgId/retry-send
  // Relance l'envoi d'un message passé en dead-letter (outbound_failed_at).
  // Reset le compteur + la marque d'échec → le worker outbound le reprend
  // au prochain tick. 404 si le message n'est pas en échec.
  fastify.post('/:id/messages/:msgId/retry-send',
    { preHandler: [fastify.authenticate] }, async (req, reply) => {
      const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
      if (!acl) return

      const { rows } = await fastify.db.query(`
        UPDATE ticket_messages
        SET outbound_failed_at = NULL, outbound_attempts = 0,
            outbound_error = NULL, email_sent_at = NULL
        WHERE id = $1 AND ticket_id = $2 AND outbound_failed_at IS NOT NULL
        RETURNING *
      `, [req.params.msgId, req.params.id])
      if (!rows.length) return reply.code(404).send({ error: 'Message non en échec ou introuvable' })
      await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
      reply.send(rows[0])
    })

  // POST /api/tickets/:id/ai-suggest
  // Génère via Ollama une suggestion de réponse / prochaine étape de
  // diagnostic à partir du contexte du ticket, et l'ajoute au fil comme un
  // message type='ai_suggestion' (jamais envoyé par mail : l'outbox filtre
  // type='comment'). Brouillon que l'admin relit/édite avant d'envoyer.
  //
  // Admin-only : le prompt inclut les notes internes et la suggestion est
  // renvoyée dans la réponse — jamais à destination d'un requester.
  fastify.post('/:id/ai-suggest', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return

    const { rows: cfgRows } = await fastify.db.query(
      `SELECT key, value FROM settings WHERE key IN
        ('tickets.assistant.enabled','tickets.assistant.url','tickets.assistant.model',
         'tickets.assistant.system_prompt')`
    )
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]))
    if (cfg['tickets.assistant.enabled'] !== 'true') {
      return reply.code(409).send({ error: 'Assistant IA désactivé' })
    }
    const url = cfg['tickets.assistant.url'], model = cfg['tickets.assistant.model']
    if (!url || !model) return reply.code(409).send({ error: 'Assistant IA non configuré' })

    const { rows: tk } = await fastify.db.query(
      `SELECT title, description, priority, status FROM tickets WHERE id = $1`, [req.params.id]
    )
    if (!tk.length) return reply.code(404).send({ error: 'Ticket introuvable' })

    // Contexte enrichi pour le diagnostic : échanges + poste concerné +
    // demandeur + tags. (Premier pas ; le RAG sur tout Opale viendra après.)
    const [msgsR, devR, reqR, tagsR] = await Promise.all([
      fastify.db.query(
        `SELECT author, content FROM ticket_messages
         WHERE ticket_id = $1 AND type IN ('comment','internal_note')
         ORDER BY created_at ASC LIMIT 20`, [req.params.id]),
      fastify.db.query(
        `SELECT d.hostname, d.os, d.model FROM ticket_devices td
         JOIN devices d ON d.id = td.device_id
         WHERE td.ticket_id = $1 ORDER BY td.added_at ASC LIMIT 1`, [req.params.id]),
      fastify.db.query(
        `SELECT u.display_name, u.job_title, u.department FROM ticket_users tu
         JOIN users_cache u ON u.entra_id = tu.user_entra_id
         WHERE tu.ticket_id = $1 AND tu.role = 'requester' LIMIT 1`, [req.params.id]),
      fastify.db.query(
        `SELECT g.name FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id
         WHERE tt.ticket_id = $1`, [req.params.id]),
    ])
    const dev = devR.rows[0]
      ? [devR.rows[0].hostname, devR.rows[0].os, devR.rows[0].model].filter(Boolean).join(' · ')
      : null
    const requester = reqR.rows[0]
      ? [reqR.rows[0].display_name, reqR.rows[0].job_title, reqR.rows[0].department].filter(Boolean).join(', ')
      : null

    let suggestion
    try {
      const gen = fastify.generateSuggestion || generateSuggestion
      suggestion = await gen({
        title: tk[0].title, description: tk[0].description,
        priority: tk[0].priority, status: tk[0].status,
        device: dev, requester, tags: tagsR.rows.map(r => r.name),
        messages: msgsR.rows, url, model,
        systemPrompt: cfg['tickets.assistant.system_prompt'],
      })
    } catch (err) {
      req.log?.warn({ err: err.message, ticketId: req.params.id }, 'ai-suggest: génération échouée')
      return reply.code(502).send({ error: 'La génération IA a échoué (Ollama indisponible ?)' })
    }

    // email_sent_at=now() : sécurité anti-outbox (en plus du filtre type).
    const { rows } = await fastify.db.query(`
      INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
      VALUES ($1, 'ai_suggestion', 'Assistant IA', $2, now())
      RETURNING *
    `, [req.params.id, suggestion])
    reply.code(201).send(rows[0])
  })

  // DELETE /api/tickets/:id/messages/:msgId — réservé aux brouillons IA.
  // On ne permet de supprimer QUE les ai_suggestion (l'historique réel des
  // échanges n'est jamais effaçable depuis l'UI).
  fastify.delete('/:id/messages/:msgId', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return
    const { rowCount } = await fastify.db.query(
      `DELETE FROM ticket_messages
       WHERE id = $1 AND ticket_id = $2 AND type = 'ai_suggestion'`,
      [req.params.msgId, req.params.id]
    )
    if (!rowCount) return reply.code(404).send({ error: 'Suggestion introuvable' })
    reply.code(204).send()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — Relations M2M users / devices + merge
  // ───────────────────────────────────────────────────────────────────────────

  // POST /api/tickets/:id/users { entra_id, role? }
  // Admin-only : seul un admin ajoute/retire des personnes d'un ticket
  // (sinon n'importe quel requester pourrait s'auto-désigner pour des
  // tickets qui ne sont pas les siens).
  fastify.post('/:id/users',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const { entra_id, role = 'involved' } = req.body || {}
      if (!entra_id) return reply.code(400).send({ error: 'entra_id requis' })
      if (!USER_ROLES.includes(role)) return reply.code(400).send({ error: 'role invalide' })

      // Vérif que le ticket existe + que le user existe (FK 404 explicite)
      const { rows: tk } = await fastify.db.query(`SELECT id FROM tickets WHERE id = $1`, [req.params.id])
      if (!tk.length) return reply.code(404).send({ error: 'Ticket introuvable' })
      const { rows: u } = await fastify.db.query(
        `SELECT entra_id, display_name, email FROM users_cache WHERE entra_id = $1`, [entra_id]
      )
      if (!u.length) return reply.code(404).send({ error: 'Utilisateur introuvable' })

      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        if (role === 'requester') await syncRequester(client, req.params.id, entra_id)
        else                       await addInvolvedUser(client, req.params.id, entra_id)
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [req.params.id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      reply.code(201).send({ entra_id, role, display_name: u[0].display_name, email: u[0].email })
    })

  // DELETE /api/tickets/:id/users/:entraId
  fastify.delete('/:id/users/:entraId',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        const removed = await removeUserFromTicket(client, req.params.id, req.params.entraId)
        if (!removed) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Lien introuvable' }) }
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [req.params.id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      reply.code(204).send()
    })

  // POST /api/tickets/:id/devices { device_id }
  fastify.post('/:id/devices',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const { device_id } = req.body || {}
      if (!device_id) return reply.code(400).send({ error: 'device_id requis' })

      const { rows: tk } = await fastify.db.query(`SELECT id FROM tickets WHERE id = $1`, [req.params.id])
      if (!tk.length) return reply.code(404).send({ error: 'Ticket introuvable' })
      const { rows: d } = await fastify.db.query(`SELECT id, hostname FROM devices WHERE id = $1`, [device_id])
      if (!d.length) return reply.code(404).send({ error: 'Device introuvable' })

      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        await addDeviceToTicket(client, req.params.id, device_id)
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [req.params.id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      reply.code(201).send({ id: device_id, hostname: d[0].hostname })
    })

  // DELETE /api/tickets/:id/devices/:deviceId
  fastify.delete('/:id/devices/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        const removed = await removeDeviceFromTicket(client, req.params.id, req.params.deviceId)
        if (!removed) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Lien introuvable' }) }
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [req.params.id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      reply.code(204).send()
    })

  // POST /api/tickets/:id/merge { target_ticket_id }
  // Fusionne le ticket :id (source) DANS target_ticket_id. Action admin-only,
  // destructive côté source (passé en status='merged'). Réversibilité : non
  // automatisée — l'admin peut toujours réouvrir le source manuellement.
  fastify.post('/:id/merge',
    { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
      const target_ticket_id = req.body?.target_ticket_id
      if (!target_ticket_id) return reply.code(400).send({ error: 'target_ticket_id requis' })

      const { displayName } = fastify.getUserIdentity(req)
      const client = await fastify.db.connect()
      try {
        await client.query('BEGIN')
        await mergeTicketInto(client, {
          sourceId: req.params.id,
          targetId: target_ticket_id,
          byName: displayName,
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.message === 'SELF_MERGE')             return reply.code(400).send({ error: 'Ne peut pas fusionner un ticket avec lui-même' })
        if (err.message === 'SOURCE_NOT_FOUND')       return reply.code(404).send({ error: 'Ticket source introuvable' })
        if (err.message === 'TARGET_NOT_FOUND')       return reply.code(404).send({ error: 'Ticket cible introuvable' })
        if (err.message === 'SOURCE_ALREADY_MERGED')  return reply.code(409).send({ error: 'Ticket source déjà fusionné' })
        if (err.message === 'TARGET_ALREADY_MERGED')  return reply.code(409).send({ error: 'Ticket cible déjà fusionné — choisir le ticket final' })
        throw err
      } finally {
        client.release()
      }
      reply.send({ merged_from: req.params.id, merged_into: target_ticket_id })
    })

  // ───────────────────────────────────────────────────────────────────────────
  // Pièces jointes (upload manuel, stockage disque)
  // ───────────────────────────────────────────────────────────────────────────

  // POST /api/tickets/:id/attachments  (multipart, 1 fichier, ≤ 25 Mo)
  // ACL : admin OU requester OU assignee (checkTicketAccess).
  fastify.post('/:id/attachments', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
    if (!acl) return

    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'Aucun fichier' })

    let saved
    try {
      saved = await saveAttachmentStream(req.params.id, part.file)
    } catch (err) {
      req.log?.warn({ err: err.message }, 'attachment: échec écriture disque')
      return reply.code(500).send({ error: 'Échec de l\'enregistrement du fichier' })
    }

    // @fastify/multipart positionne file.truncated quand la limite fileSize
    // est dépassée — le fichier sur disque est alors incomplet, on le purge.
    if (part.file.truncated) {
      await deleteAttachmentFile(saved.storagePath).catch(() => {})
      return reply.code(413).send({ error: 'Fichier trop volumineux (max 25 Mo)' })
    }

    const { entraId, displayName } = acl
    const { rows } = await fastify.db.query(`
      INSERT INTO ticket_attachments
        (ticket_id, filename, mime_type, size_bytes, storage_path,
         uploaded_by_entra_id, uploaded_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, filename, mime_type, size_bytes, uploaded_by_name, created_at
    `, [req.params.id, part.filename, part.mimetype || null, saved.sizeBytes,
        saved.storagePath, entraId, displayName])

    await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(201).send(rows[0])
  })

  // GET /api/tickets/:id/attachments/:attId/download
  fastify.get('/:id/attachments/:attId/download',
    { preHandler: [fastify.authenticate] }, async (req, reply) => {
      const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
      if (!acl) return

      const { rows } = await fastify.db.query(
        `SELECT filename, mime_type, storage_path FROM ticket_attachments
         WHERE id = $1 AND ticket_id = $2`,
        [req.params.attId, req.params.id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Pièce jointe introuvable' })
      const a = rows[0]

      // application/octet-stream + attachment : on ne sert jamais le fichier
      // en inline (un SVG/HTML uploadé ne doit pas s'exécuter dans l'origin).
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', contentDisposition(a.filename))
        .header('X-Content-Type-Options', 'nosniff')
      try {
        return reply.send(openAttachment(a.storage_path))
      } catch (err) {
        req.log?.warn({ err: err.message }, 'attachment: fichier disque manquant')
        return reply.code(410).send({ error: 'Fichier non disponible' })
      }
    })

  // DELETE /api/tickets/:id/attachments/:attId
  fastify.delete('/:id/attachments/:attId',
    { preHandler: [fastify.authenticate] }, async (req, reply) => {
      const acl = await checkTicketAccess(fastify, req, reply, req.params.id)
      if (!acl) return

      const { rows } = await fastify.db.query(
        `DELETE FROM ticket_attachments WHERE id = $1 AND ticket_id = $2
         RETURNING storage_path`,
        [req.params.attId, req.params.id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Pièce jointe introuvable' })
      // Best-effort : la row est partie, on nettoie le fichier disque.
      await deleteAttachmentFile(rows[0].storage_path).catch(() => {})
      reply.code(204).send()
    })

  // POST /api/tickets/:id/tags  { tag_id }
  fastify.post('/:id/tags', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const tag_id = req.body?.tag_id
    if (!tag_id) return reply.code(400).send({ error: 'tag_id requis' })

    try {
      await fastify.db.query(
        `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.params.id, tag_id]
      )
      await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
      reply.code(201).send({ ok: true })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ error: 'Ticket ou tag introuvable' })
      throw err
    }
  })

  // DELETE /api/tickets/:id/tags/:tagId
  fastify.delete('/:id/tags/:tagId', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    await fastify.db.query(
      'DELETE FROM ticket_tags WHERE ticket_id = $1 AND tag_id = $2',
      [req.params.id, req.params.tagId]
    )
    await fastify.db.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [req.params.id])
    reply.code(204).send()
  })
}
