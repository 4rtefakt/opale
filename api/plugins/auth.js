import crypto from 'crypto'
import fp from 'fastify-plugin'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const JWKS_CACHE_MS = 10 * 60 * 1000

// Entra signe ses JWT en RS256. Ses clés publiées (JWKS) ne portent pas de
// champ `alg` : sans liste d'algorithmes, jose accepterait aussi une
// signature PS256 faite avec la même clé RSA. On épingle l'algorithme
// attendu (défense en profondeur contre la confusion d'algorithmes).
export const JWT_ALGORITHMS = ['RS256']

// Retourne la fonction qui fournit le JWKS à jwtVerify. En test, `jwks`
// (createLocalJWKSet) évite le fetch HTTPS. En prod, le JWKS distant
// Microsoft est construit UNE seule fois : jose gère lui-même le cache
// (cacheMaxAge), le rafraîchissement quand une clé tourne (kid inconnu) et
// le cooldown anti-martèlement. Le reconstruire périodiquement jetait cet
// état interne et forçait un téléchargement à froid à chaque cycle.
export function makeJwksGetter({
  jwks = null,
  createRemote = () => createRemoteJWKSet(
    new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
    { cacheMaxAge: JWKS_CACHE_MS }
  ),
} = {}) {
  let remote = null
  return function getJWKS() {
    if (jwks) return jwks
    if (!remote) remote = createRemote()
    return remote
  }
}

async function authPlugin(fastify, opts = {}) {
  // Sans ENTRA_CLIENT_ID, verifyToken passerait `audience: undefined` à
  // jwtVerify, qui ne vérifie alors AUCUNE audience : tout token du tenant,
  // émis pour n'importe quelle autre application, serait accepté. Sans
  // ENTRA_TENANT_ID, aucun issuer ne correspondrait. On refuse de démarrer
  // plutôt que de dégrader l'authentification en silence.
  assertEntraConfig()

  // En prod opts.jwks est undefined → JWKS distant login.microsoftonline.com.
  // En test on passe createLocalJWKSet pour éviter le fetch HTTPS et
  // valider la chaîne signature + iss + aud sur une keypair locale.
  const getJWKS = makeJwksGetter({ jwks: opts.jwks || null })

  async function verifyToken(token) {
    assertEntraConfig()
    const clientId = process.env.ENTRA_CLIENT_ID
    const tenantId = process.env.ENTRA_TENANT_ID
    const issuers = [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`
    ]
    const audiences = [clientId, `api://${clientId}`]

    for (const issuer of issuers) {
      for (const audience of audiences) {
        try {
          const { payload } = await jwtVerify(token, getJWKS(), { issuer, audience, algorithms: JWT_ALGORITHMS })
          return payload
        } catch {}
      }
    }
    throw new Error('Token invalide')
  }

  // Exposé pour le WebSocket SSH (auth hors preHandler)
  fastify.decorate('verifyToken', async function (token) {
    const payload = await verifyToken(token)
    return {
      entraId:     payload.oid || payload.sub,
      email:       payload.preferred_username || payload.upn || payload.email,
      displayName: payload.name
    }
  })

  // Lookup d'un token CLI à partir de sa partie secrète (hex 64 chars).
  // Le préfixe `opl_` éventuel a été stripé par l'appelant — on hash
  // uniquement le secret pour rester compatible avec les tokens legacy
  // (PR #104 émettait les tokens sans préfixe).
  async function lookupCliToken(secret, request, reply) {
    const hash = crypto.createHash('sha256').update(secret).digest('hex')
    const { rows } = await fastify.db.query(`
      SELECT ct.id, ct.entra_id, uc.display_name, uc.email
      FROM cli_tokens ct
      JOIN users_cache uc ON uc.entra_id = ct.entra_id
      WHERE ct.token_hash = $1
        AND ct.revoked_at IS NULL
        AND (ct.expires_at IS NULL OR ct.expires_at > now())
    `, [hash])

    if (!rows[0]) {
      return reply.code(401).send({ error: 'Token invalide' })
    }
    fastify.db.query('UPDATE cli_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id])
      .catch(err => fastify.log.warn({ err: err.message }, 'cli_tokens last_used_at update failed'))
    // Synthetic payload : aucune route n'accède à jwtPayload au-delà de
    // oid/name/preferred_username (cf. getUserIdentity + requireAdmin),
    // donc on remplit juste ces trois champs.
    request.jwtPayload = {
      oid:                rows[0].entra_id,
      name:               rows[0].display_name,
      preferred_username: rows[0].email,
    }
  }

  fastify.decorate('authenticate', async function (request, reply) {
    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token manquant' })
    }
    const token = auth.slice(7)

    // 1. Préfixe explicite `opl_` → token CLI (nouveau format depuis cette PR).
    //    Le préfixe est un marker de discrimination, jamais inclus dans le hash
    //    DB : permet une rétrocompatibilité avec les tokens hex64 émis par PR
    //    #104. Pattern repris de GitHub (ghp_), Slack (xoxb_) etc.
    if (token.startsWith('opl_')) {
      return lookupCliToken(token.slice(4), request, reply)
    }

    // 2. JWT Entra strict : exactement 3 segments séparés par des points
    //    (header.payload.signature). Ancien check `includes('.')` acceptait
    //    `a.b`, `a.b.c.d`, etc. → erreur 401 silencieuse moins descriptive.
    if (token.split('.').length === 3) {
      try {
        request.jwtPayload = await verifyToken(token)
        return
      } catch {
        return reply.code(401).send({ error: 'Token invalide' })
      }
    }

    // 3. Legacy : token CLI hex 64 chars sans préfixe (compat PR #104).
    //    À retirer une fois tous les anciens tokens expirés (90 j max).
    if (/^[0-9a-f]{64}$/i.test(token)) {
      return lookupCliToken(token, request, reply)
    }

    return reply.code(401).send({ error: 'Token invalide' })
  })

  fastify.decorate('requireAdmin', async function (request, reply) {
    const entraId = request.jwtPayload?.oid || request.jwtPayload?.sub
    if (!entraId) return reply.code(401).send({ error: 'Non authentifié' })
    const res = await fastify.db.query(
      'SELECT is_admin FROM users_cache WHERE entra_id = $1',
      [entraId]
    )
    if (!res.rows[0]?.is_admin) {
      return reply.code(403).send({ error: 'Non autorisé' })
    }
  })

  // Variant non-bloquant : retourne un booléen pour les routes qui appliquent
  // une ACL custom (ex: admin OR propriétaire d'une ressource).
  fastify.decorate('isAdmin', async function (request) {
    const entraId = request.jwtPayload?.oid || request.jwtPayload?.sub
    if (!entraId) return false
    const res = await fastify.db.query(
      'SELECT is_admin FROM users_cache WHERE entra_id = $1',
      [entraId]
    )
    return !!res.rows[0]?.is_admin
  })

  fastify.decorate('getUserIdentity', function (request) {
    const p = request.jwtPayload
    if (!p) return null
    return {
      entraId: p.oid || p.sub,
      email: p.preferred_username || p.upn || p.email,
      displayName: p.name
    }
  })
}

function assertEntraConfig() {
  const missing = ['ENTRA_CLIENT_ID', 'ENTRA_TENANT_ID'].filter(k => !process.env[k]?.trim())
  if (missing.length) {
    throw new Error(`Configuration Entra incomplète : ${missing.join(', ')} requis (cf. .env.example)`)
  }
}

export default fp(authPlugin)
