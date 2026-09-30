// Clé d'escrow de l'instance (docs/linux-fleet-design.md §5, décision §9.3) :
// état (EscrowStatus) et confirmation, une fois par clé, de sa sauvegarde
// hors site — porte qui débloque l'escrow des clés de récupération LUKS.

import { adminRoute } from '../lib/admin-route.js'
import { linuxViewContext, listLinuxDevices } from '../lib/device-view.js'
import { readEscrowStatus } from '../lib/settings.js'
import { lapsKey } from '../../inventory/lib/laps-key.js'
import { logAudit } from '../../core/lib/audit.js'

export default async function escrowRoutes(fastify) {
  const { db } = fastify
  const status = async () => {
    const [escrow, needing] = await Promise.all([
      readEscrowStatus(db, fastify.log),
      listLinuxDevices(db, { escrow: 'missing', limit: 1 }, await linuxViewContext({ lapsKey, log: fastify.log })),
    ])
    return { ...escrow, devices_needing_escrow: needing.total }
  }

  fastify.get('/escrow/status', adminRoute(fastify, 'linuxEscrowStatus'), status)

  // Liée à la clé courante : si la clé servie change, la confirmation stockée
  // ne correspond plus (lecture par key_id) et l'escrow LUKS se referme.
  fastify.post('/escrow/confirm-backup', adminRoute(fastify, 'linuxConfirmEscrowBackup'), async (req, reply) => {
    const { key_id } = lapsKey.info(fastify.log)
    if (!key_id || req.body.key_id !== key_id) {
      return reply.code(409).send({ error: 'La clé d’escrow a changé depuis le chargement de la page', code: 'KEY_ID_MISMATCH' })
    }
    const { displayName, entraId } = fastify.getUserIdentity(req)
    const by = displayName || entraId
    const confirmation = { key_id, by, at: new Date().toISOString() }
    await db.query(`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('linux.escrow_backup_confirmed', $1, now(), $2)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now(), updated_by = $2
    `, [JSON.stringify(confirmation), by])
    await logAudit(db, fastify.log, { action: 'linux_escrow_backup_confirmed', byUser: by, details: { key_id } })
    return status()
  })
}
