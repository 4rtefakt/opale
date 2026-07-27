import fp from 'fastify-plugin'

// En-têtes de sécurité HTTP, appliqués à TOUTES les réponses.
//
// Avant ce plugin, la seule protection était `frame-ancestors 'self'`, posée
// sur les fichiers statiques et le fallback SPA — donc absente des réponses
// d'API. Ni HSTS, ni X-Content-Type-Options, ni Referrer-Policy, ni
// Permissions-Policy, et surtout aucune directive `script-src`.
//
// Pris isolément chacun est mineur. Combinés au style de rendu du front —
// plus de 300 affectations `innerHTML` par interpolation de chaînes, sans
// framework ni échappement automatique — ils déterminent l'impact d'un unique
// `esc()` oublié : sans CSP, ça devient l'exécution de JS arbitraire dans la
// console d'administration d'un RMM qui dispose de SSH, LAPS et de
// l'exécution de scripts.
//
// Pas de dépendance @fastify/helmet : ce qui est nécessaire ici tient en un
// objet d'en-têtes, et un paquet de moins dans un produit qui manipule des
// clés SSH est un paquet de moins à auditer.

// ── CSP ───────────────────────────────────────────────────────────────────
// Le front est entièrement auto-hébergé (cf. setup.sh, qui vendorise MSAL,
// xterm, Chart.js et Tabler Icons dans front/) : aucune ressource externe
// n'est chargée, `'self'` suffit donc partout.
//
// `style-src` tolère 'unsafe-inline' : les vues utilisent massivement des
// attributs `style=` inline. Les retirer supposerait de réécrire le rendu
// des 19 vues ; c'est un chantier distinct, et l'injection de style est très
// loin de l'injection de script en termes d'impact.
//
// `connect-src` autorise les schémas ws/wss pour les terminaux SSH et console.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
]

export const CSP = CSP_DIRECTIVES.join('; ')

export function buildSecurityHeaders(env = process.env) {
  const headers = {
    'Content-Security-Policy': CSP,
    // Empêche un navigateur de « deviner » qu'une pièce jointe texte est en
    // réalité du HTML et de l'exécuter.
    'X-Content-Type-Options': 'nosniff',
    // frame-ancestors le couvre déjà pour les navigateurs récents ; conservé
    // pour les plus anciens.
    'X-Frame-Options': 'SAMEORIGIN',
    // Ne fuite pas le chemin consulté (souvent un id de poste ou de ticket)
    // vers les sites tiers atteints depuis l'interface.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Opale n'a besoin d'aucune de ces API.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // Isole le contexte de navigation des fenêtres ouvertes par l'interface.
    'Cross-Origin-Opener-Policy': 'same-origin',
  }

  // HSTS uniquement en production : en développement l'API est servie en clair
  // sur localhost, et un HSTS posé là épinglerait le navigateur sur https pour
  // tout localhost — y compris les autres projets du poste, très pénible à
  // défaire. La directive n'a de toute façon d'effet que sur une réponse
  // servie en HTTPS.
  if (env.NODE_ENV === 'production' && env.OPALE_DISABLE_HSTS !== 'true') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  }

  return headers
}

async function securityHeadersPlugin(fastify) {
  const headers = buildSecurityHeaders()
  fastify.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(headers)) {
      // onSend s'exécute après les handlers : une route qui a délibérément
      // posé son propre en-tête (ex. une CSP plus stricte sur un rendu
      // spécifique) garde la main.
      if (!reply.hasHeader(name)) reply.header(name, value)
    }
    return payload
  })
}

export default fp(securityHeadersPlugin)
