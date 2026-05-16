// Module email-bridge : pont bidirectionnel mail ↔ Tickets Opale.
// Cf. issue #8.
//
// Phasage :
//   - Phase 1 (CURRENT) : lecture polling Graph + log + table mapping.
//                         AUCUNE création de ticket / proposition.
//   - Phase 2 : classification IA → création de ticket_proposals
//   - Phase 3 : acceptation auto pour expéditeurs connus + PJ
//   - Phase 4 : envoi sortant (Mail.Send + headers de threading)
//   - Phase 5 : bouton "pas un ticket" + signal d'apprentissage

import emailRoute from './routes/email.js'
import { startMailPollWorker }       from './lib/poll-worker.js'
import { startMailOutboundWorker }   from './lib/outbound-worker.js'
import { startMailMarkReadWorker }   from './lib/mark-read-worker.js'

export default {
  name: 'email-bridge',
  // Phase 2/3 : on écrit dans ticket_proposals + ticket_messages → tickets
  // doit être chargé pour que les tables existent (FK). `tickets` lui-même
  // dépend de `inventory` (devices.assigned_user_id pour le matching),
  // le loader résout la chaîne via topo sort.
  requires: ['core', 'tickets'],

  async register(fastify) {
    await fastify.register(emailRoute, { prefix: '/api/email' })
  },

  startWorkers(fastify) {
    startMailPollWorker(fastify.db, fastify.log)
    startMailOutboundWorker(fastify.db, fastify.log)
    startMailMarkReadWorker(fastify.db, fastify.log)
  }
}
