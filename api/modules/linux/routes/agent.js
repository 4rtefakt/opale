// Routes appelées par l'agent Linux (requêtes signées Ed25519).
// Le plugin device-auth (parser JSON brut + preValidation) est enregistré ici
// pour rester encapsulé dans ce scope : /enroll, /checkin et /reports.

import deviceAuthPlugin from '../plugins/device-auth.js'
import { schemaFor } from '../lib/spec.js'
import { enrollDevice } from '../lib/enrollment.js'
import { checkin } from '../lib/checkin.js'
import { recordReport, alertApplyFailure } from '../lib/reports.js'
import { createDeviceRateLimiter } from '../lib/device-rate.js'
import { lapsKey } from '../../inventory/lib/laps-key.js'
import { ipOnlyKey } from '../../../lib/rate-limit.js'

const REFUSED = {
  rejected:        { error: 'Enrôlement rejeté', code: 'REJECTED' },
  revoked:         { error: 'Clé révoquée', code: 'REVOKED' },
  serial_mismatch: { error: 'Numéro de série différent de celui enrôlé', code: 'SERIAL_MISMATCH' },
}

export default async function agentRoutes(fastify) {
  await deviceAuthPlugin(fastify)
  const { db, gitMirror, gitTokenStore } = fastify

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

  // Clé approuvée seulement ; 12 check-ins par heure et par poste, comptés
  // après vérification de la signature (design §1).
  const checkinRate = createDeviceRateLimiter({ max: 12, windowMs: 3600_000 })
  fastify.post('/checkin', {
    schema: schemaFor('linuxAgentCheckin'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: ipOnlyKey }, operationId: 'linuxAgentCheckin' },
    preValidation: fastify.deviceAuth(),
  }, async (req, reply) => {
    const limit = checkinRate.hit(req.deviceKey.device_id)
    if (!limit.ok) {
      return reply.code(429).header('Retry-After', Math.ceil(limit.retry_after_ms / 1000))
        .send({ error: 'Trop de check-ins pour ce poste', code: 'DEVICE_RATE_LIMIT', retry_after_ms: limit.retry_after_ms })
    }
    const result = await checkin(db, fastify.log, { key: req.deviceKey, body: req.body }, { gitMirror, gitTokenStore, lapsKey })
    if (result.status === 'serial_mismatch') return reply.code(403).send(REFUSED.serial_mismatch)
    return result.assignment
  })

  // Un rapport par exécution d'ansible-pull ; les alertes d'un passage en
  // échec sont best-effort, hors du chemin de réponse (un endpoint push lent
  // ne retarde pas l'agent) et n'empêchent jamais le 201 (design §4).
  const reportRate = createDeviceRateLimiter({ max: 12, windowMs: 3600_000 })
  fastify.post('/reports', {
    schema: schemaFor('linuxAgentReport'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: ipOnlyKey }, operationId: 'linuxAgentReport' },
    preValidation: fastify.deviceAuth(),
  }, async (req, reply) => {
    const limit = reportRate.hit(req.deviceKey.device_id)
    if (!limit.ok) {
      return reply.code(429).header('Retry-After', Math.ceil(limit.retry_after_ms / 1000))
        .send({ error: 'Trop de rapports pour ce poste', code: 'DEVICE_RATE_LIMIT', retry_after_ms: limit.retry_after_ms })
    }
    const result = await recordReport(db, fastify.log, { deviceId: req.deviceKey.device_id, fingerprint: req.deviceKey.key_fingerprint, body: req.body })
    if (result.transition === 'failed') void alertApplyFailure(fastify, result)
    return reply.code(201).send({ id: result.id, received_at: result.received_at, transition: result.transition })
  })
}
