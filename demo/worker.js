// Démo publique d'Opale sur Cloudflare Workers.
//
// Le Worker sert le front tel quel (assets statiques depuis ../front) et
// remplace l'API par une version factice en mémoire (api.js + seed.js) :
// aucune base, aucun Entra, aucun agent. Chaque visiteur reçoit son propre
// jeu de données (cookie), remis à zéro au bout de 2 h ou via « Réinitialiser »
// dans le bandeau. Rien n'est persisté nulle part.

import { seed } from './seed.js'
import { handleApi } from './api.js'

const COOKIE = 'opale_demo'
const TTL_MS = 2 * 3_600_000
const MAX_STATES = 400
const states = new Map()   // id → { state, at }

function getState(id) {
  const cur = states.get(id)
  if (cur && Date.now() - cur.at < TTL_MS) return cur.state
  if (states.size >= MAX_STATES) {
    // Le plus ancien part (Map conserve l'ordre d'insertion).
    states.delete(states.keys().next().value)
  }
  const state = seed()
  states.delete(id)
  states.set(id, { state, at: Date.now() })
  return state
}

function readCookie(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{8,64})`))
  return m ? m[1] : null
}
function newId() { return crypto.randomUUID().replace(/-/g, '') }
function cookieHeader(id, maxAge = 86_400) { return `${COOKIE}=${id}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly; Secure` }

const js = (code) => new Response(code, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

const BRANDING = { org_name: 'Démo Opale', product_name: 'Opale', tagline: 'Open RMM platform — démo', default_role_label: 'IT' }
const MODULES = { core: true, inventory: true, monitoring: true, remote: true, tickets: true, onboarding: true, groups: true, 'email-bridge': true, ask: true, linux: true, hardware: true }

function envScript() {
  const env = { ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '', API_BASE_URL: '/api', SSH_USER: 'opale', SSH_PORT: 22, BRANDING, DEMO: true }
  return `(typeof window !== 'undefined' ? window : self).ENV = ${JSON.stringify(env)};\n` +
         `(typeof window !== 'undefined' ? window : self).OPALE = ${JSON.stringify({ modules: MODULES, demo: true })};`
}

const MANIFEST = {
  name: 'Opale (démo)', short_name: 'Opale', description: 'Démo publique d\'Opale — données fictives',
  start_url: '/mobile.html', scope: '/', display: 'standalone', background_color: '#11141C', theme_color: '#11141C',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/env.js') return js(envScript())
    if (path === '/manifest.json') return json(MANIFEST, 200, { 'Cache-Control': 'public, max-age=300' })
    // Le vrai serveur sert le branding depuis /branding/* ; ici une seule icône.
    if (path.startsWith('/branding/')) return env.ASSETS.fetch(new Request(new URL('/icon.svg', url), request))

    if (path.startsWith('/api/')) {
      // Le front ne pose jamais de cookie lui-même : c'est le Worker qui
      // attribue l'identifiant de visiteur à la première requête API.
      let id = readCookie(request)
      const fresh = !id
      if (fresh) id = newId()

      if (path === '/api/demo/reset') {
        states.delete(id)
        return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(id) })
      }
      // WebSockets SSH / console : aucun agent derrière la démo.
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return json({ error: 'Accès distant indisponible dans la démo' }, 403)
      }
      const res = await handleApi(request, url, getState(id))
      if (!fresh) return res
      const out = new Response(res.body, res)
      out.headers.append('Set-Cookie', cookieHeader(id))
      return out
    }

    return env.ASSETS.fetch(request)
  },
}
