// Ask Opale — endpoint d'orchestration.
//
// Pipeline (lecture seule) :
//   question FR
//     → askProvider           (LLM → QuerySpec brut)        [provider.js]
//     → validateQuerySpec     (frontière de sécurité)       [queryspec.js]
//     → resolveSpec           (noms → identifiants, DB)      [resolve.js]
//     → compile               (QuerySpec → SQL paramétré)    [compile.js]
//     → db.query              (exécution)
//     → { rows, total, spec } (rendu côté front via vues filtrées)
//
// Admin-only : interroge tout le parc (données techniques sensibles), comme
// les autres surfaces d'inventaire/conformité. La clé API vient de l'env
// OPALE_ASK_API_KEY (jamais des settings — anti-fuite via GET /api/settings).

import { askProvider }       from '../lib/provider.js'
import { validateQuerySpec } from '../lib/queryspec.js'
import { resolveSpec }       from '../lib/resolve.js'
import { compile }           from '../lib/compile.js'
import { describeRegistry }  from '../lib/registry.js'
import { logAudit }          from '../../core/lib/audit.js'

const SETTINGS_KEYS = ['ask.enabled', 'ask.provider', 'ask.url', 'ask.model', 'disk_warn_pct', 'disk_critical_pct', 'org.name']

async function loadConfig(fastify) {
  const { rows } = await fastify.db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`, [SETTINGS_KEYS]
  )
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    enabled:  s['ask.enabled'] === 'true',
    provider: s['ask.provider'] || 'mistral',
    url:      s['ask.url'] || '',
    model:    s['ask.model'] || '',
    apiKey:   process.env.OPALE_ASK_API_KEY || '',
    // Contexte d'organisation injecté dans le prompt système — vient du
    // setting, jamais du code (Opale est auto-hébergé par des tiers).
    orgName:  s['org.name'] || '',
    thresholds: {
      warn:     parseInt(s.disk_warn_pct ?? '80', 10),
      critical: parseInt(s.disk_critical_pct ?? '90', 10),
    },
  }
}

export default async function askRoute(fastify) {
  // GET /api/ask/capabilities — catalogue interrogeable + état (sans secret).
  // Sert au front (autocomplétion / aide) et à la transparence.
  fastify.get('/capabilities', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const cfg = await loadConfig(fastify)
    return {
      enabled:    cfg.enabled,
      provider:   cfg.provider,
      configured: Boolean(cfg.model && cfg.apiKey),
      resources:  describeRegistry(),
    }
  })

  // POST /api/ask — { question } → résultats.
  fastify.post('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const question = (req.body?.question || '').toString().trim()
    if (!question) return reply.code(400).send({ error: 'question requise' })

    const cfg = await loadConfig(fastify)
    if (!cfg.enabled)            return reply.code(503).send({ error: 'Ask Opale est désactivé' })
    if (!cfg.model || !cfg.apiKey) {
      return reply.code(503).send({ error: 'Ask Opale non configuré (model / clé API manquants)' })
    }

    // 1) LLM → QuerySpec brut.
    let raw
    try {
      raw = await askProvider({
        provider: cfg.provider, url: cfg.url, key: cfg.apiKey, model: cfg.model, question,
        orgContext: cfg.orgName,
      })
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'ask: provider failed')
      return reply.code(502).send({ error: `Provider IA indisponible : ${err.message}` })
    }

    // 2) Validation stricte (anti-hallucination de colonne).
    const validated = validateQuerySpec(raw)
    if (!validated.ok) {
      return reply.code(422).send({ error: "Je n'ai pas su traduire cette demande.", details: validated.errors, raw })
    }

    // 3) Résolution des valeurs (groupes, users, tags, départements).
    const resolved = await resolveSpec(fastify.db, validated.spec)
    if (!resolved.ok) {
      return reply.code(422).send({ error: 'Référence introuvable.', details: resolved.errors, spec: validated.spec })
    }

    // 4) Compilation + exécution.
    const { text, params } = compile(resolved.spec, { thresholds: cfg.thresholds })
    let result
    try {
      result = await fastify.db.query(text, params)
    } catch (err) {
      fastify.log.error({ err: err.message, spec: resolved.spec }, 'ask: SQL execution failed')
      return reply.code(500).send({ error: 'Erreur lors de la requête.' })
    }

    const total = result.rows.length ? parseInt(result.rows[0]._total) : 0
    const rows = result.rows.map(({ _total, ...rest }) => rest)

    const { displayName, entraId } = fastify.getUserIdentity(req)
    logAudit(fastify.db, fastify.log, {
      action: 'ask_query',
      byUser: displayName || entraId,
      target: question.slice(0, 200),
      details: { resource: resolved.spec.resource, total },
    })

    return {
      resource: resolved.spec.resource,
      spec:     resolved.spec,
      total,
      count:    rows.length,
      rows,
    }
  })
}
