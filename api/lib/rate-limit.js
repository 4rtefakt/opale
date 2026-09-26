// Identification du client pour le rate-limit (@fastify/rate-limit) et
// confiance accordée au reverse proxy (option `trustProxy` de Fastify).
//
// Sans trustProxy, `req.ip` est l'adresse du pair TCP : derrière Caddy /
// nginx, c'est celle du proxy pour TOUTES les requêtes, qui partagent donc
// le même compteur. TRUST_PROXY permet à Fastify de lire X-Forwarded-For
// pour retrouver l'IP réelle du client.

import crypto from 'node:crypto'
import net from 'node:net'

// Mots-clés reconnus par proxy-addr (utilisé par Fastify).
const PROXY_ADDR_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal'])

function isIpOrCidr(entry) {
  if (PROXY_ADDR_KEYWORDS.has(entry)) return true
  const [addr, prefix, ...rest] = entry.split('/')
  const family = net.isIP(addr)
  if (!family || rest.length) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  return Number(prefix) <= (family === 4 ? 32 : 128)
}

// Valeur de TRUST_PROXY → option `trustProxy` de Fastify :
//   absent / '' / false / 0 / no / off  → false (défaut : pas de proxy de confiance)
//   true / yes / on                     → true (fait confiance à tout X-Forwarded-For : à éviter)
//   liste 'ip,cidr,…'                   → adresses de proxy de confiance (recommandé)
// Un nombre de sauts (« 1 ») est refusé : il ne vérifie pas le pair TCP, donc
// un client qui joint le port en direct peut forger X-Forwarded-For
// (GHSA-3m5p-2c4r-xxw2) ; Fastify ≥ 5.12 le traite d'ailleurs comme « aucun
// proxy de confiance », ce qui rendrait le réglage silencieusement inopérant.
// Toute autre valeur lève : on refuse de démarrer sur une config ambiguë.
export function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim()
  const lower = v.toLowerCase()
  if (!v || ['false', '0', 'no', 'off'].includes(lower)) return false
  if (['true', 'yes', 'on'].includes(lower)) return true
  if (/^\d+$/.test(v)) {
    throw new Error(`TRUST_PROXY invalide (${v}) — un nombre de proxies n'est pas sûr : indiquer l'IP ou le CIDR du reverse proxy`)
  }
  const entries = v.split(',').map(s => s.trim()).filter(Boolean)
  const invalid = entries.filter(e => !isIpOrCidr(e))
  if (!entries.length || invalid.length) {
    throw new Error(`TRUST_PROXY invalide (${invalid.join(', ') || v}) — attendu : une liste d'IP/CIDR du reverse proxy (ou true, déconseillé)`)
  }
  return entries
}

// Clé par défaut des routes limitées : IP + 16 hex du hash du Bearer, pour
// limiter par couple (machine, token) — évite qu'un seul token spam une IP
// partagée sans borner les hits légitimes d'autres tokens depuis la même IP.
// À réserver aux routes AUTHENTIFIÉES : sur une route sans auth, un Bearer
// aléatoire suffirait à obtenir un compteur neuf à chaque requête.
export function rateLimitKey(req) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) {
    const hash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 16)
    return `${req.ip}|${hash}`
  }
  return req.ip
}

// Clé des routes non authentifiées (setup-log, exchange-token) : IP seule.
export function ipOnlyKey(req) {
  return req.ip
}

// Options d'enregistrement du plugin : opt-in route par route
// (`config: { rateLimit: { max, timeWindow } }`).
// L'objet renvoyé par errorResponseBuilder est levé par le plugin puis
// traité par plugins/error-handler.js : sans `statusCode` il devenait une
// 500 « Erreur interne » ; `message` alimente le champ `error` de la réponse.
export const rateLimitOptions = {
  global: false,
  keyGenerator: rateLimitKey,
  errorResponseBuilder: (req, ctx) => ({
    statusCode:     ctx.statusCode,
    message:        'Trop de requêtes',
    error:          'Trop de requêtes',
    retry_after_ms: ctx.ttl
  }),
}
