// Helper JWT pour les tests d'auth. Génère une keypair RS256 ad hoc,
// expose :
//   - `jwks`   : un JWKSet local (createLocalJWKSet) à passer en option au
//                register de plugins/auth.js. Évite le fetch HTTPS vers
//                login.microsoftonline.com en test.
//   - `sign()` : signe un JWT avec la priv key correspondante, en utilisant
//                par défaut iss/aud cohérents avec les env ENTRA_TENANT_ID /
//                ENTRA_CLIENT_ID.
//
// Pourquoi pas mocker fetch : jose@5 côté Node utilise `https.get` natif
// (cf. node_modules/jose/dist/node/esm/runtime/fetch_jwks.js), pas
// globalThis.fetch. Stubber globalThis.fetch ne fait rien. L'injection
// du JWKS via opts.jwks au register est le bord propre.

import crypto from 'node:crypto'
import {
  generateKeyPair,
  SignJWT,
  exportJWK,
  createLocalJWKSet,
} from 'jose'

export async function setupTestJwks() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  pubJwk.kid = crypto.randomBytes(8).toString('hex')
  pubJwk.alg = 'RS256'
  pubJwk.use = 'sig'

  const jwks = createLocalJWKSet({ keys: [pubJwk] })

  return {
    jwks,
    publicKid: pubJwk.kid,
    sign: async (payload, { iss, aud, exp = '1h', alg = 'RS256' } = {}) => {
      const tenantId = process.env.ENTRA_TENANT_ID || 'test-tenant'
      const clientId = process.env.ENTRA_CLIENT_ID || 'test-client'
      return new SignJWT(payload)
        .setProtectedHeader({ alg, kid: pubJwk.kid })
        .setIssuedAt()
        .setIssuer(iss || `https://login.microsoftonline.com/${tenantId}/v2.0`)
        .setAudience(aud || clientId)
        .setExpirationTime(exp)
        .sign(privateKey)
    },
  }
}
