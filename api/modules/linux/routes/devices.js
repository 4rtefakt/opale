// Postes gérés par état désiré — dans cette PR : révocation de la clé.
// Liste, détail, assignation et rapports arrivent avec les PR suivantes.

import { adminRoute, sendRefusal } from '../lib/admin-route.js'
import { revokeDeviceKey } from '../lib/enrollment.js'
import { loadLinuxDeviceDetail } from '../lib/device-view.js'

const REFUSAL_MESSAGES = {
  NOT_FOUND:     'Poste Linux introuvable',
  NO_ACTIVE_KEY: 'Aucune clé approuvée à révoquer',
}

export default async function devicesRoutes(fastify) {
  fastify.post('/devices/:id/revoke', adminRoute(fastify, 'linuxRevokeDevice'), async (req, reply) => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const result = await revokeDeviceKey(fastify.db, fastify.log, displayName || entraId, req.params.id, req.body.reason)
    if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    return loadLinuxDeviceDetail(fastify.db, req.params.id)
  })
}
