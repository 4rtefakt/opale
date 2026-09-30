// Options Fastify d'une route admin du module : schéma et operationId tirés
// de la spec, garde admin, et `requireInteractive` quand l'opération porte
// `x-opale-interactive: true` (tokens CLI refusés, 403 INTERACTIVE_ONLY).
// `config` complète la config de route (ex. rateLimit).
import { operations, schemaFor } from './spec.js'

export function adminRoute(fastify, operationId, config = {}) {
  const op = operations().find(o => o.operationId === operationId)
  if (!op) throw new Error(`Opération inconnue : ${operationId}`)
  const preHandler = [fastify.authenticate, fastify.requireAdmin]
  if (op.interactive) preHandler.push(fastify.requireInteractive)
  return { schema: schemaFor(operationId), config: { operationId, ...config }, preHandler }
}

// Réponse d'un refus de helper ({ ok: false, status, code, details }).
export function sendRefusal(reply, refusal, messages) {
  const error = messages[refusal.code] ?? refusal.code
  return reply.code(refusal.status).send({ error, code: refusal.code, details: refusal.details })
}
