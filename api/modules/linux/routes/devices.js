// Postes gérés par état désiré (docs/linux-fleet-design.md §5) : liste paginée,
// détail, historique des rapports, affectation (simple et en lot), révocation
// de la clé, clés de récupération (métadonnées, révélation fail-closed avec
// motif), KPIs du parc. La clé d'escrow de l'instance : routes/escrow.js.

import { adminRoute, sendRefusal } from '../lib/admin-route.js'
import { revokeDeviceKey } from '../lib/enrollment.js'
import { changeAssignment, assignBulk } from '../lib/assignment.js'
import { linuxViewContext, listLinuxDevices, loadLinuxDeviceDetail } from '../lib/device-view.js'
import { listReports } from '../lib/reports.js'
import { listRecoveryKeys, revealRecoveryKey } from '../lib/recovery-keys.js'
import { linuxDashboard } from '../lib/dashboard.js'
import { setAssignedUser } from '../../inventory/lib/assign-user.js'
import { lapsKey } from '../../inventory/lib/laps-key.js'

const REFUSAL_MESSAGES = {
  NOT_FOUND:      'Poste Linux introuvable',
  NO_ACTIVE_KEY:  'Aucune clé approuvée à révoquer',
  UNKNOWN_USER:   'Utilisateur inconnu',
  DECRYPT_FAILED: 'Déchiffrement impossible côté serveur',
  AUDIT_FAILED:   'Trace d’audit impossible : secret non révélé',
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

  fastify.get('/devices/:id/recovery-keys', adminRoute(fastify, 'linuxListRecoveryKeys'), async (req, reply) => {
    const rows = await listRecoveryKeys(db, req.params.id, lapsKey.info(fastify.log).key_id)
    return rows ? { rows } : notFound(reply)
  })

  // Le secret n'est envoyé qu'après validation de la trace d'audit (motif) et
  // de last_viewed_* — voir revealRecoveryKey. Motif déjà validé par le schéma.
  fastify.post('/devices/:id/recovery-keys/:kid/reveal', adminRoute(fastify, 'linuxRevealRecoveryKey', { rateLimit: { max: 10, timeWindow: '1 minute' } }), async (req, reply) => {
    const { entraId } = fastify.getUserIdentity(req)
    const result = await revealRecoveryKey(db, fastify.log, {
      deviceId: req.params.id, keyId: req.params.kid, byUser: actor(req), viewerId: entraId, reason: req.body.reason,
    }, { lapsKey })
    if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    return result.secret
  })

  fastify.get('/dashboard', adminRoute(fastify, 'linuxDashboard'), async () => {
    return linuxDashboard(db, await context(), gitMirror.status().state)
  })
}
