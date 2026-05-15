import crypto from 'crypto'
import { logAudit } from '../lib/audit.js'

const CLI_TOKEN_TTL_DAYS = 90
const CLI_TOKEN_PREFIX   = 'opl_'

// Secret = 32 bytes hex (64 chars). Le préfixe `opl_` est concaténé pour
// transit mais NE FAIT PAS partie du hash (cf. plugins/auth.js
// lookupCliToken) → rétrocompatibilité avec tokens legacy hex64 émis par
// PR #104 (pré-préfixe).
function genCliToken() {
  const secret = crypto.randomBytes(32).toString('hex')
  return { secret, full: CLI_TOKEN_PREFIX + secret }
}
function hashSecret(s) { return crypto.createHash('sha256').update(s).digest('hex') }

export default async function authRoute(fastify) {

  // GET /api/auth/config — public, pas d'auth.
  // Retourne les paramètres OIDC nécessaires au CLI pour démarrer le flow PKCE.
  // client_id et tenant_id ne sont pas des secrets (visibles dans le flow browser).
  fastify.get('/config', async (req, reply) => {
    reply.send({
      client_id: process.env.ENTRA_CLIENT_ID || null,
      tenant_id: process.env.ENTRA_TENANT_ID || null,
    })
  })

  // POST /api/auth/cli-token
  // Exchange : un JWT Entra valide → un token CLI préfixé longue durée.
  // Utilisé par `opale auth login` après le callback MSAL. Le JWT Entra
  // n'est jamais stocké ; seul le hash SHA-256 du secret est conservé.
  //
  // Rate limit : 5/min — un humain login rarement plus que ça, et un JWT
  // compromis serait throttlé sur la génération massive de tokens.
  fastify.post('/cli-token', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config:     { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { label = 'CLI' } = req.body || {}
    if (typeof label !== 'string' || !label.trim()) {
      return reply.code(400).send({ error: 'label requis' })
    }
    if (label.length > 100) {
      return reply.code(400).send({ error: 'label trop long (max 100 caractères)' })
    }

    const identity  = fastify.getUserIdentity(req)
    const { secret, full } = genCliToken()
    const hash      = hashSecret(secret)
    const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

    const { rows } = await fastify.db.query(`
      INSERT INTO cli_tokens (label, token_hash, entra_id, created_by, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, label, created_at, expires_at
    `, [label.trim(), hash, identity.entraId, identity.displayName, expiresAt])

    // Audit enrichi avec l'ID du token et l'expiration : permet de retracer
    // précisément un token donné en cas d'incident (sinon il faut joindre
    // cli_tokens par label, ambigu si plusieurs tokens partagent le même).
    await logAudit(fastify.db, fastify.log, {
      action: 'cli_token_created',
      byUser: identity.displayName,
      target: label.trim(),
      details: { token_id: rows[0].id, expires_at: rows[0].expires_at },
    })

    // Token retourné en clair une seule fois — jamais récupérable ensuite.
    // Format : `opl_<hex64>` (préfixe = marker de discrimination dans le
    // plugin authenticate, sans impact sur le hash stocké).
    reply.code(201).send({ ...rows[0], token: full })
  })
}
