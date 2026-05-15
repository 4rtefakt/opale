import { searchAADGroups } from '../../core/lib/graph.js'
import { syncGroupMemberships } from '../lib/group-sync.js'

// Groupes Entra — endpoints pour l'UI (autocomplete, sync manuel)
export default async function groupsRoute(fastify) {

  // GET /api/groups/search?q=... — autocomplete groupes Entra
  fastify.get('/search', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const q = (req.query.q || '').trim()
    if (!q) return reply.send([])
    try {
      const groups = await searchAADGroups(q)
      reply.send(groups.map(g => ({ id: g.id, displayName: g.displayName, description: g.description || null })))
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'groups search échoué')
      // Microsoft Graph répond 403 si l'app registration n'a pas la permission
      // Group.Read.All (Application). Message explicite pour aider l'admin.
      const isPermErr = /\b403\b/.test(err.message)
      const userMsg = isPermErr
        ? "Recherche de groupes Entra refusée par Microsoft Graph (HTTP 403). " +
          "L'app registration de cette instance doit avoir la permission " +
          "Group.Read.All (Application) — accordée par un admin Entra."
        : `Recherche groupe Entra échouée : ${err.message}`
      reply.code(502).send({ error: userMsg })
    }
  })

  // POST /api/groups/sync — déclenche une sync manuelle des memberships (admin)
  fastify.post('/sync', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    try {
      const result = await syncGroupMemberships(fastify.db, fastify.log)
      reply.send(result)
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'groups sync échoué')
      reply.code(500).send({ error: err.message })
    }
  })

}
