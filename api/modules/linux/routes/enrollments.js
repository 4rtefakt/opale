// File d'attente d'enrôlement (docs/linux-fleet-design.md §5) :
// liste, compteur, approbation (simple / conversion / ré-enrôlement / lot),
// rejet (simple / lot). Schémas et garde interactive tirés de la spec.

import { adminRoute, sendRefusal } from '../lib/admin-route.js'
import { approveEnrollment, approveEnrollments, rejectEnrollment, rejectEnrollments } from '../lib/enrollment.js'
import { listEnrollments, loadEnrollment, loadLinuxDeviceDetail } from '../lib/device-view.js'

export const REFUSAL_MESSAGES = {
  NOT_FOUND:       'Demande d’enrôlement introuvable',
  NOT_PENDING:     'Demande déjà traitée',
  CONFLICT:        'Série déjà connue : choisir une conversion ou un remplacement de clé',
  ACTIVE_TOKEN:    'Le poste a encore un token agent actif : cocher la révocation pour convertir',
  ACTIVE_KEY:      'Le poste a déjà une clé approuvée : cocher le remplacement pour ré-enrôler',
  HOSTNAME_TAKEN:  'Nom d’hôte déjà utilisé par un autre poste',
  SERIAL_MISMATCH: 'Le numéro de série ne correspond pas au poste ciblé',
  UNKNOWN_USER:    'Utilisateur inconnu',
}

export default async function enrollmentsRoutes(fastify) {
  const db = fastify.db
  const actor = req => {
    const { displayName, entraId } = fastify.getUserIdentity(req)
    return displayName || entraId
  }

  fastify.get('/enrollments', adminRoute(fastify, 'linuxListEnrollments'), async req => {
    const { status = 'pending', limit, offset } = req.query
    return listEnrollments(db, { status, limit, offset })
  })

  fastify.get('/enrollments/count', adminRoute(fastify, 'linuxCountEnrollments'), async () => {
    const { rows: [row] } = await db.query("SELECT count(*)::int AS pending FROM linux_device_keys WHERE status = 'pending'")
    return row
  })

  fastify.post('/enrollments/approve-bulk', adminRoute(fastify, 'linuxApproveBulk'), async req => {
    const { ids, profile, ring } = req.body
    return approveEnrollments(db, fastify.log, actor(req), { ids, profile, ring })
  })

  fastify.post('/enrollments/reject-bulk', adminRoute(fastify, 'linuxRejectBulk'), async req => {
    const { ids, reason = null } = req.body
    return rejectEnrollments(db, fastify.log, actor(req), { ids, reason })
  })

  fastify.post('/enrollments/:id/approve', adminRoute(fastify, 'linuxApproveEnrollment'), async (req, reply) => {
    const { profile, ring, hostname, assigned_user_id, convert_device_id, revoke_active_token, supersede } = req.body
    const result = await approveEnrollment(db, fastify.log, actor(req), req.params.id, {
      profile, ring, hostname, assigned_user_id, convert_device_id, revoke_active_token, supersede,
    })
    if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    // Conversion : le tube WS de l'ancien agent Windows est fermé après COMMIT
    // (ses tokens sont révoqués dans la transaction).
    if (result.converted) fastify.agentWs?.evictDevice(result.device.id, 'converted-to-pull')
    return loadLinuxDeviceDetail(db, result.device.id)
  })

  // Corps optionnel dans la spec (requestBody.required: false) : sans corps,
  // Fastify validerait `undefined` contre le schéma objet → 400.
  const reject = adminRoute(fastify, 'linuxRejectEnrollment')
  reject.preValidation = async req => { req.body ??= {} }
  fastify.post('/enrollments/:id/reject', reject, async (req, reply) => {
    const result = await rejectEnrollment(db, fastify.log, actor(req), req.params.id, req.body.reason ?? null)
    if (!result.ok) return sendRefusal(reply, result, REFUSAL_MESSAGES)
    return loadEnrollment(db, result.key.id)
  })
}
