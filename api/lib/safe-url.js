// Contrôle des URL sortantes configurables (fournisseurs LLM).
//
// Trois settings pilotent des appels `fetch()` depuis le serveur :
// `ask.url`, `mail.classifier.url` et `tickets.assistant.url`. Sans contrôle,
// un compte administrateur compromis peut les pointer vers un hôte arbitraire
// et obtenir deux choses :
//
//   • du SSRF — le serveur émet des requêtes vers le réseau interne ;
//   • surtout, l'exfiltration de OPALE_ASK_API_KEY, que provider.js place
//     dans l'en-tête `x-api-key` / `Authorization` de chaque appel.
//
// Le contrôle retenu est une ALLOWLIST D'HÔTES, pas un filtrage d'IP privées :
// Opale s'appuie précisément sur un Ollama auto-hébergé joignable par son nom
// de service Docker (`http://ollama:11434`), donc bannir le réseau privé
// casserait le produit. Une allowlist inverse la charge de la preuve — seul un
// hôte explicitement autorisé peut recevoir un secret — et elle n'est
// modifiable que par quelqu'un qui a la main sur l'environnement du
// conteneur, pas par une simple session admin.
//
// La validation est appliquée AU MOMENT DE L'APPEL (provider.js, assistant.js,
// classify.js) et non seulement à l'écriture du setting : c'est ce qui la rend
// efficace quelle que soit la façon dont la valeur est arrivée en base
// (PATCH /api/settings, migration, psql direct).

const DEFAULT_ALLOWED_HOSTS = [
  'api.anthropic.com',   // provider ask = anthropic
  'api.mistral.ai',      // provider ask = mistral
  'ollama',              // service Ollama de docker-compose (classifier + assistant tickets)
  'localhost',
  '127.0.0.1',
  '::1',
]

export function allowedLlmHosts(env = process.env) {
  const extra = String(env.OPALE_LLM_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])
}

// Normalise un hostname pour comparaison : minuscules, point final retiré
// (`ollama.` et `ollama` désignent le même hôte), crochets IPv6 retirés.
function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
}

/**
 * Valide une URL de fournisseur LLM. Lève une Error explicite si elle est
 * refusée, retourne l'URL normalisée (sans slash final) sinon.
 *
 * @param {string} raw     - valeur brute du setting
 * @param {string} label   - nom du setting, pour le message d'erreur
 */
export function assertSafeLlmUrl(raw, label = 'url', env = process.env) {
  const value = String(raw ?? '').trim()
  if (!value) throw new Error(`${label} : URL vide`)

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} : URL invalide (« ${value.slice(0, 80)} »)`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} : schéma « ${url.protocol.replace(':', '')} » refusé (http ou https attendu)`)
  }

  // Des identifiants dans l'URL (user:pass@host) sont soit une erreur de
  // configuration, soit une tentative de contourner la lecture de l'hôte.
  if (url.username || url.password) {
    throw new Error(`${label} : les identifiants dans l'URL ne sont pas acceptés`)
  }

  const host = normalizeHost(url.hostname)
  const allowed = allowedLlmHosts(env)
  if (!allowed.has(host)) {
    throw new Error(
      `${label} : hôte « ${host} » non autorisé. ` +
      `Hôtes acceptés : ${[...allowed].sort().join(', ')}. ` +
      `Pour en ajouter un, définissez OPALE_LLM_ALLOWED_HOSTS côté environnement du serveur ` +
      `(volontairement hors de portée d'une session admin).`
    )
  }

  // http:// vers un hôte externe enverrait la clé API en clair sur le réseau.
  // Toléré uniquement pour les hôtes locaux / le service Ollama interne.
  const LOCAL = new Set(['localhost', '127.0.0.1', '::1', 'ollama'])
  if (url.protocol === 'http:' && !LOCAL.has(host)) {
    throw new Error(`${label} : http:// refusé vers « ${host} » (https requis hors réseau local)`)
  }

  return url.toString().replace(/\/$/, '')
}

// Variante non levante — pour la validation à l'écriture d'un setting, où on
// veut renvoyer un 400 propre plutôt que de propager une exception.
export function checkSafeLlmUrl(raw, label, env = process.env) {
  try {
    return { ok: true, url: assertSafeLlmUrl(raw, label, env) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
