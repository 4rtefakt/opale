// Routes /api/network — visibilité du trafic réseau parc.
//
// Conformité : surveillance d'utilisation réseau par poste est une donnée
// comportementale d'employé. Avant déploiement, vérifier que votre
// charte interne (CSE, règlement intérieur, etc.) autorise explicitement
// cette consultation. Chaque accès est tracé dans audit_logs pour
// traçabilité (qui a regardé quoi quand).

import { fetchTopBandwidth, TOP_BANDWIDTH_PERIODS, TOP_BANDWIDTH_SORTS } from '../lib/bandwidth.js'
// (intra-monitoring : pas de changement de chemin)
import { logAudit } from '../../core/lib/audit.js'

export default async function networkRoute(fastify) {

  // GET /api/network/top?period=24h&sort=total&limit=20
  //   period : '4h' | '24h' | '7d'              (défaut 24h)
  //   sort   : 'total' | 'sent' | 'recv'         (défaut total)
  //   limit  : 1..100                            (défaut 20)
  //
  // Admin only. Trace chaque consultation dans audit_logs avec les params
  // — permet à un DPO de retracer "qui a regardé les chiffres de qui quand".
  fastify.get('/top', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (req, reply) => {
    const period = req.query.period && TOP_BANDWIDTH_PERIODS.includes(req.query.period)
      ? req.query.period
      : '24h'
    const sort = req.query.sort && TOP_BANDWIDTH_SORTS.includes(req.query.sort)
      ? req.query.sort
      : 'total'
    const limit = (() => {
      const n = parseInt(req.query.limit, 10)
      if (!Number.isFinite(n) || n < 1) return 20
      if (n > 100) return 100
      return n
    })()

    const rows = await fetchTopBandwidth(fastify.db, { period, sort, limit })

    // Audit best-effort — un échec ne doit pas bloquer la réponse, mais on
    // log un warning pour visibilité.
    const identity = fastify.getUserIdentity(req)
    logAudit(fastify.db, fastify.log, {
      action: 'network_view_accessed',
      byUser: identity?.displayName || null,
      details: { period, sort, limit, count: rows.length },
    })

    reply.send({ rows, period, sort, limit })
  })
}
