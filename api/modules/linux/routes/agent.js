// Routes appelées par l'agent Linux (requêtes signées Ed25519).
// Le plugin device-auth (parser JSON brut + preValidation) est enregistré ici
// pour rester encapsulé dans ce scope. Cette PR : /enroll uniquement.

import deviceAuthPlugin from '../plugins/device-auth.js'
import { schemaFor } from '../lib/spec.js'
import { enrollDevice } from '../lib/enrollment.js'
import { ipOnlyKey } from '../../../lib/rate-limit.js'

const REFUSED = {
  rejected:        { error: 'Enrôlement rejeté', code: 'REJECTED' },
  revoked:         { error: 'Clé révoquée', code: 'REVOKED' },
  serial_mismatch: { error: 'Numéro de série différent de celui enrôlé', code: 'SERIAL_MISMATCH' },
}

export default async function agentRoutes(fastify) {
  await deviceAuthPlugin(fastify)

  // Clé inconnue acceptée ici seulement : la signature est vérifiée contre
  // `public_key` du corps, dont l'empreinte doit égaler x-opale-key.
  // Limite par IP seule : jamais par empreinte (un enrôlement n'est pas
  // encore authentifié par une clé connue).
  fastify.post('/enroll', {
    schema: schemaFor('linuxAgentEnroll'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: ipOnlyKey }, operationId: 'linuxAgentEnroll' },
    bodyLimit: 4096,
    preValidation: fastify.deviceAuth({ allowStatuses: ['pending', 'approved', 'rejected', 'revoked'], allowUnknown: true }),
  }, async (req, reply) => {
    const { serial, hostname, os_version, agent_version, key_backing, public_key } = req.body
    const fingerprint = req.headers['x-opale-key'].toLowerCase()
    const result = await enrollDevice(fastify.db, fastify.log, {
      fingerprint, publicKeyRaw: Buffer.from(public_key, 'base64'), keyBacking: key_backing,
      serialClaimed: serial, hostnameClaimed: hostname, osVersion: os_version, agentVersion: agent_version, ip: req.ip,
    })
    if (result.status === 'flood') {
      return reply.code(429).header('Retry-After', result.retryAfterS)
        .send({ error: 'File d’enrôlement pleine, réessayer plus tard', code: 'ENROLL_FLOOD', retry_after_ms: result.retryAfterS * 1000 })
    }
    if (result.status === 'pending') {
      return reply.code(202).send({ status: 'pending', code: fingerprint.slice(0, 8), retry_after_s: result.retryAfterS, conflict: result.key.conflict })
    }
    if (result.status === 'approved') {
      return { status: 'approved', device_id: result.device.id, hostname: result.device.hostname }
    }
    return reply.code(403).send({ status: result.status, ...REFUSED[result.status] })
  })
}
