// Endpoint /env.js — injecte la config publique dans window.ENV au boot du front.
// Inclut un sous-objet BRANDING lu depuis la table `settings` (cache mémoire 60s).
// Le cache est invalidé côté settings.js sur PATCH via fastify.invalidateBrandingCache().
// Wrapped dans fastify-plugin pour que le décorateur soit visible depuis settings.js
// (sans fp, l'encapsulation Fastify v4 cache les decorators au scope parent).

import fp from 'fastify-plugin'
import { modulesConfig } from '../../../modules.config.js'

const BRANDING_KEYS = ['org.name', 'app.product_name', 'app.tagline', 'app.default_role_label']
const BRANDING_DEFAULTS = {
  org_name:           'Your Organization',
  product_name:       'Opale',
  tagline:            'Open RMM platform',
  default_role_label: 'IT',
}
const CACHE_TTL_MS = 60 * 1000

let _cache = null
let _cacheAt = 0

function keyToField(key) {
  // 'org.name' -> 'org_name', 'app.product_name' -> 'product_name'
  if (key === 'org.name') return 'org_name'
  return key.replace(/^app\./, '').replace(/\./g, '_')
}

async function loadBranding(db) {
  const now = Date.now()
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache

  const { rows } = await db.query(
    'SELECT key, value FROM settings WHERE key = ANY($1)',
    [BRANDING_KEYS]
  )
  const branding = { ...BRANDING_DEFAULTS }
  for (const r of rows) {
    branding[keyToField(r.key)] = r.value
  }
  _cache = branding
  _cacheAt = now
  return branding
}

export function invalidateBrandingCache() {
  _cache = null
  _cacheAt = 0
}

async function envRoute(fastify) {
  fastify.decorate('invalidateBrandingCache', invalidateBrandingCache)

  fastify.get('/env.js', async (req, reply) => {
    const branding = await loadBranding(fastify.db)
    reply.header('Content-Type', 'application/javascript')
    reply.header('Cache-Control', 'no-store')
    const env = {
      ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID || '',
      ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID || '',
      API_BASE_URL:    process.env.API_BASE_URL    || '/api',
      SSH_USER:        process.env.SSH_USER        || 'opale',
      SSH_PORT:        parseInt(process.env.SSH_PORT || '22', 10),
      BRANDING:        branding,
    }
    // Modules activés — exposés au front via window.OPALE.modules pour
    // conditionner l'affichage des éléments UI cross-module (boutons, menus,
    // widgets dashboard). Cf. docs/ROADMAP.md.
    const opale = { modules: { ...modulesConfig } }
    // Double-écriture window/self pour pouvoir importScripts() depuis le service worker.
    return (
      `(typeof window !== 'undefined' ? window : self).ENV = ${JSON.stringify(env)};\n` +
      `(typeof window !== 'undefined' ? window : self).OPALE = ${JSON.stringify(opale)};`
    )
  })
}

export default fp(envRoute)
