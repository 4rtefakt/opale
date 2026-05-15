// Sert /manifest.json en runtime, en injectant le branding courant depuis
// la table settings. La PWA installée reflète ainsi le nom de l'instance,
// pas le défaut "Opale" du fichier statique d'origine (qui a été
// supprimé pour éviter qu'il soit consommé par erreur).
//
// Cache mémoire 60s (aligné sur env.js). Invalidé sur PATCH /api/settings
// touchant une clé de branding (cf. settings.js → invalidateManifestCache).
// Wrapped dans fastify-plugin pour que le décorateur soit visible depuis
// settings.js (sans fp, l'encapsulation Fastify v4 le cache au scope parent).
//
// Routes Fastify ont priorité sur le wildcard de @fastify/static : ce
// handler intercepte /manifest.json même si un fichier du même nom traîne
// dans front/.

import fp from 'fastify-plugin'

const BRANDING_KEYS = ['app.product_name', 'app.tagline']
const DEFAULTS = {
  product_name: 'Opale',
  tagline:      'Open RMM platform',
}
const CACHE_TTL_MS = 60 * 1000

let _cache = null
let _cacheAt = 0

function shortNameFrom(full) {
  // "Opale" → "Opale", "Acme · RMM" → "Acme". Premier token de ≥ 2 chars.
  const first = String(full || '').split(/[\s·]+/).find(s => s.length >= 2)
  return first || 'RMM'
}

async function loadBranding(db) {
  const now = Date.now()
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache

  const { rows } = await db.query(
    'SELECT key, value FROM settings WHERE key = ANY($1)',
    [BRANDING_KEYS]
  )
  const out = { ...DEFAULTS }
  for (const r of rows) {
    if (r.key === 'app.product_name' && r.value) out.product_name = r.value
    if (r.key === 'app.tagline'      && r.value) out.tagline      = r.value
  }
  _cache = out
  _cacheAt = now
  return out
}

export function invalidateManifestCache() {
  _cache = null
  _cacheAt = 0
}

async function manifestRoute(fastify) {
  fastify.decorate('invalidateManifestCache', invalidateManifestCache)

  fastify.get('/manifest.json', async (req, reply) => {
    const b = await loadBranding(fastify.db)
    const manifest = {
      name:             b.product_name,
      short_name:       shortNameFrom(b.product_name),
      description:      b.tagline,
      start_url:        '/mobile.html',
      scope:            '/',
      display:          'standalone',
      orientation:      'portrait',
      background_color: '#0f1117',
      theme_color:      '#0f1117',
      icons: [
        { src: '/branding/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/branding/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
      ],
    }
    reply.header('Content-Type', 'application/manifest+json')
    reply.header('Cache-Control', 'no-store')
    return reply.send(manifest)
  })
}

export default fp(manifestRoute)
