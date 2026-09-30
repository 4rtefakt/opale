// Réglages du module Linux (préfixe /api/linux) : lecture, et modification auditée
// avec avant/après par clé. Design : docs/linux-fleet-design.md §5.
import { readLinuxSettings, readEscrowStatus, validateLinuxSettings } from '../lib/settings.js'
import { schemaFor } from '../lib/spec.js'
import { logAudit } from '../../core/lib/audit.js'

export default async function settingsRoutes(fastify) {
  const { gitMirror, db } = fastify
  const admin       = [fastify.authenticate, fastify.requireAdmin]
  const interactive = [...admin, fastify.requireInteractive]
  // LinuxSettings de la spec = réglages + état d'escrow (même source que /escrow/status).
  const withEscrow = async settings => ({ ...settings, escrow: await readEscrowStatus(db, fastify.log) })

  fastify.get('/settings', {
    schema: schemaFor('linuxGetSettings'), config: { operationId: 'linuxGetSettings' }, preHandler: admin,
  }, async () => withEscrow(await readLinuxSettings(db)))

  fastify.patch('/settings', {
    schema: schemaFor('linuxUpdateSettings'), config: { operationId: 'linuxUpdateSettings' }, preHandler: interactive,
  }, async (req, reply) => {
    const error = validateLinuxSettings(req.body, gitMirror)
    if (error) return reply.code(400).send({ error, code: 'VALIDATION' })
    const before = await readLinuxSettings(db)
    const { displayName } = fastify.getUserIdentity(req)
    const changes = {}
    const rows = []
    const change = (name, previous, next, key, stored) => {
      if (JSON.stringify(previous) === JSON.stringify(next)) return
      changes[name] = { before: previous, after: next }
      rows.push([key, stored])
    }
    const body = req.body
    if (body.repo_url !== undefined) change('repo_url', before.repo_url, body.repo_url, 'linux.repo_url', body.repo_url)
    if (body.allowed_signers !== undefined) {
      change('allowed_signers', before.allowed_signers, body.allowed_signers, 'linux.allowed_signers', JSON.stringify(body.allowed_signers))
    }
    if (body.alerts_enabled !== undefined) change('alerts_enabled', before.alerts_enabled, body.alerts_enabled, 'linux.alerts_enabled', String(body.alerts_enabled))
    for (const ring of ['pilot', 'stable']) {
      const branch = body.rings?.[ring]?.branch
      if (branch !== undefined) change(`rings.${ring}.branch`, before.rings[ring].branch, branch, `linux.ring.${ring}`, JSON.stringify({ branch }))
    }
    for (const [key, value] of rows) {
      await db.query(`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3
      `, [key, value, displayName])
    }
    const after = await readLinuxSettings(db)
    if (rows.length) {
      await logAudit(db, fastify.log, { action: 'linux_settings_changed', byUser: displayName, details: { changes } })
      await gitMirror.configure(after)
      // Le re-pointage clone/fetch en arrière-plan : le statut du miroir en rend compte.
      if (changes.repo_url) gitMirror.setUpstream(after.repo_url).catch(() => {})
    }
    return withEscrow(after)
  })
}
