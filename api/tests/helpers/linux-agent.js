// Faux agent Linux pour les tests de routes : paire Ed25519 jetable,
// empreinte, corps d'enrôlement conforme à EnrollRequest et requête signée
// (docs/linux-fleet-design.md §1) prête pour app.inject().

import { createHash, generateKeyPairSync } from 'node:crypto'
import { signRequest } from '../../modules/linux/lib/device-auth.js'

export function newAgent({
  serial = 'SN-LX-0001',
  hostname = 'debian',
  osVersion = 'Debian GNU/Linux 12 (bookworm)',
  agentVersion = '0.1.0',
  keyBacking = 'software',
} = {}) {
  const pair = generateKeyPairSync('ed25519')
  const publicKeyRaw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const fingerprint = createHash('sha256').update(publicKeyRaw).digest('hex')
  return {
    privateKey: pair.privateKey, publicKeyRaw, fingerprint, code: fingerprint.slice(0, 8),
    body: {
      serial, hostname, os_version: osVersion, agent_version: agentVersion,
      key_backing: keyBacking, public_key: publicKeyRaw.toString('base64'),
    },
  }
}

// POST signé. `body` surcharge le corps par défaut de l'agent ; `ip` isole
// les compteurs de rate-limit par test ; `overrides` va à signRequest
// (timestamp, nonce, fingerprint…).
export function signedPost(app, agent, target, { body = {}, ip = '203.0.113.5', ...overrides } = {}) {
  const payload = Buffer.from(JSON.stringify({ ...agent.body, ...body }))
  const headers = signRequest({
    privateKey: agent.privateKey, fingerprint: agent.fingerprint, method: 'POST', target, body: payload, ...overrides,
  })
  return app.inject({
    method: 'POST', url: target, remoteAddress: ip,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  })
}

export function enroll(app, agent, options) {
  return signedPost(app, agent, '/api/linux/agent/enroll', options)
}
