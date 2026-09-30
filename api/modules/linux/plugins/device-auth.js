import { verifyDeviceRequest } from '../lib/device-auth.js'
import { createNonceStore } from '../lib/nonce-store.js'

// À installer dans le scope des routes agent ; aucun fastify-plugin global.
export default async function deviceAuthPlugin(fastify) {
  const nonceStore = createNonceStore()
  fastify.decorateRequest('rawBody', null)
  fastify.decorateRequest('deviceKey', null)
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    try {
      done(null, body.length ? JSON.parse(body) : {})
    } catch (e) {
      e.statusCode = 400
      done(e)
    }
  })

  fastify.decorate('deviceAuth', function ({ allowStatuses, allowUnknown = false } = {}) {
    return async function (req, reply) {
      const result = await verifyDeviceRequest({
        method: req.method,
        target: req.raw.url,
        headers: req.headers,
        rawBody: req.rawBody ?? Buffer.alloc(0),
        now: Math.floor(Date.now() / 1000),
        allowStatuses,
        allowUnknown,
        nonceStore,
        lookupKey: async fingerprint => {
          const { rows } = await fastify.db.query(`
            SELECT id, device_id, key_fingerprint, public_key, status, serial_claimed
            FROM linux_device_keys WHERE key_fingerprint = $1
          `, [fingerprint])
          return rows[0] ?? null
        },
      })
      if (!result.ok) {
        const body = { error: result.message, code: result.code }
        if (result.server_time !== undefined) body.server_time = result.server_time
        return reply.code(401).send(body)
      }
      req.deviceKey = result.key
    }
  })
}
