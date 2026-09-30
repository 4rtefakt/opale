// Pré-inscriptions : liste, import de lignes, préparation de la migration
// de postes existants, suppression d'une réservation encore ouverte.

import { adminRoute } from '../lib/admin-route.js'
import { importRows, fromDevices, listPreregistrations } from '../lib/preregistrations.js'

export default async function preregistrationsRoutes(fastify) {
  const db = fastify.db
  const actor = req => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    return displayName || entraId
  }

  fastify.get('/preregistrations', adminRoute(fastify, 'linuxListPreregistrations'), async req => {
    const { consumed = false, limit, offset } = req.query
    return listPreregistrations(db, { consumed, limit, offset })
  })

  fastify.post('/preregistrations', adminRoute(fastify, 'linuxCreatePreregistrations'), async req => {
    return importRows(db, fastify.log, actor(req), req.body.rows)
  })

  fastify.post('/preregistrations/from-devices', adminRoute(fastify, 'linuxPreregisterFromDevices'), async req => {
    const { device_ids, group_id, profile, ring } = req.body
    return fromDevices(db, fastify.log, actor(req), { deviceIds: device_ids ?? [], groupId: group_id, profile, ring })
  })

  // Une réservation consommée fait partie de l'historique du poste : 404.
  fastify.delete('/preregistrations/:id', adminRoute(fastify, 'linuxDeletePreregistration'), async (req, reply) => {
    const { rowCount } = await db.query(
      'DELETE FROM linux_preregistrations WHERE id = $1 AND consumed_at IS NULL', [req.params.id]
    )
    if (!rowCount) return reply.code(404).send({ error: 'Pré-inscription introuvable ou déjà consommée', code: 'NOT_FOUND' })
    return reply.code(204).send()
  })
}
