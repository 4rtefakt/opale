// Postes gérés par état désiré (docs/linux-fleet-design.md §5) : liste paginée,
// détail, historique des rapports, affectation (simple et en lot), révocation
// de la clé, état de la clé d'escrow, KPIs du parc. Les clés de récupération
// arrivent avec la PR suivante.

import { adminRoute, sendRefusal } from '../lib/admin-route.js'
import { revokeDeviceKey } from '../lib/enrollment.js'
import { changeAssignment, assignBulk } from '../lib/assignment.js'
import { linuxViewContext, listLinuxDevices, loadLinuxDeviceDetail } from '../lib/device-view.js'
import { listReports } from '../lib/reports.js'
import { linuxDashboard } from '../lib/dashboard.js'
import { readEscrowStatus } from '../lib/settings.js'
import { setAssignedUser } from '../../inventory/lib/assign-user.js'
import { lapsKey } from '../../inventory/lib/laps-key.js'

const REFUSAL_MESSAGES = {
  NOT_FOUND:     'Poste Linux introuvable',
  NO_ACTIVE_KEY: 'Aucune clé approuvée à révoquer',
  UNKNOWN_USER:  'Utilisateur inconnu',
}

export default async function devicesRoutes(fastify) {
  const { db, gitMirror } = fastify
  const context = () => linuxViewContext({ gitMirror, lapsKey, log: fastify.log })
  const actor = req => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    return displayName || entraId
  }
  const notFound = reply => reply.code(404).send({ error: REFUSAL_MESSAGES.NOT_FOUND, code: 'NOT_FOUND' })

  fastify.get('/devices', adminRoute(fastify, 'linuxListDevices'), async req => {
    return listLinuxDevices(db, req.query, await context())
  })

  fastify.post('/devices/assign-bulk', adminRoute(fastify, 'linuxAssignBulk'), async (req, reply) => {
    const { ids, group_id, profile, ring } = req.body
    if (profile === undefined && ring === undefined) {
      return reply.code(400).send({ error: 'Indiquer un profil et/ou un ring', code: 'NOTHING_TO_ASSIGN' })
    }
    return assignBulk(db, fastify.log, actor(req), { ids, groupId: group_id, profile, ring })
  })

  fastify.get('/devices/:id', adminRoute(fastify, 'linuxGetDevice'), async (req, reply) => {
    const detail = await loadLinuxDeviceDetail(db, req.params.id, await context())
    return detail ?? notFound(reply)
  })

  fastify.patch('/devices/:id', adminRoute(fastify, 'linuxUpdateDevice'), async (req, reply) => {
    const { profile, ring, assigned_user_id } = req.body
    const changed = await changeAssignment(db, fastify.log, actor(req), req.params.id, { profile, ring })
    if (!changed) return notFound(reply)
    if (assigned_user_id !== undefined) {
      const result = await setAssignedUser(db, fastify.log, actor(req), req.params.id, assigned_user_id)
      if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    }
    return loadLinuxDeviceDetail(db, req.params.id, await context())
  })

  fastify.get('/devices/:id/reports', adminRoute(fastify, 'linuxListReports'), async (req, reply) => {
    const page = await listReports(db, req.params.id, req.query)
    return page ?? notFound(reply)
  })

  fastify.post('/devices/:id/revoke', adminRoute(fastify, 'linuxRevokeDevice'), async (req, reply) => {
    const result = await revokeDeviceKey(db, fastify.log, actor(req), req.params.id, req.body.reason)
    if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    return loadLinuxDeviceDetail(db, req.params.id, await context())
  })

  // État de la clé d'escrow (EscrowStatus) ; la confirmation de sauvegarde est la PR 5.
  fastify.get('/escrow/status', adminRoute(fastify, 'linuxEscrowStatus'), async () => {
    const [escrow, needing] = await Promise.all([
      readEscrowStatus(db, fastify.log),
      listLinuxDevices(db, { escrow: 'missing', limit: 1 }, await linuxViewContext({ lapsKey, log: fastify.log })),
    ])
    return { ...escrow, devices_needing_escrow: needing.total }
  })

  fastify.get('/dashboard', adminRoute(fastify, 'linuxDashboard'), async () => {
    return linuxDashboard(db, await context(), gitMirror.status().state)
  })
}
