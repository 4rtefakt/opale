// Validation des endpoints de souscription Web Push.
//
// `POST /api/push/subscribe` accepte un objet PushSubscription fourni par le
// client et le stocke ; le serveur émet ensuite une requête HTTP vers
// `subscription.endpoint` à chaque notification. Sans contrôle, cet endpoint
// est une URL arbitraire choisie par l'appelant — donc une primitive SSRF :
// le serveur POSTe vers l'hôte de son choix, à répétition, à chaque alerte.
//
// L'endpoint d'un vrai service de push est toujours une URL https vers un nom
// d'hôte public (FCM, Mozilla autopush, WNS, Apple). On refuse donc ce qui ne
// peut pas en être un : schéma non-https, hôte en littéral IP, nom local.
//
// On ne va PAS jusqu'à une allowlist des quatre fournisseurs connus : elle
// casserait les déploiements qui utilisent un service de push auto-hébergé, et
// la contrainte « https + nom d'hôte public » suffit à écarter le scan de
// réseau interne, qui est le vrai gain ici.

const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost'])

// Un hôte entièrement numérique-et-points, ou entre crochets, est une IP
// littérale. Les services de push publient des noms de domaine.
function isIpLiteral(hostname) {
  return /^\[.*\]$/.test(hostname)            // IPv6 entre crochets
      || /^[0-9.]+$/.test(hostname)           // IPv4 pointée (et formes décimales)
      || /^[0-9a-f:]+$/i.test(hostname) && hostname.includes(':')  // IPv6 nue
}

/**
 * @returns {{ok: true, endpoint: string} | {ok: false, error: string}}
 */
export function checkPushEndpoint(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: false, error: 'endpoint manquant' }
  if (value.length > 2000) return { ok: false, error: 'endpoint trop long' }

  let url
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: 'endpoint : URL invalide' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'endpoint : https requis' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'endpoint : identifiants non acceptés dans l\'URL' }
  }

  const host = url.hostname.toLowerCase()
  if (LOCAL_NAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'endpoint : hôte local refusé' }
  }
  if (isIpLiteral(host)) {
    return { ok: false, error: 'endpoint : adresse IP littérale refusée' }
  }
  // Un nom sans point ne peut pas être un domaine public (`db`, `ollama`, un
  // nom de service Docker…).
  if (!host.includes('.')) {
    return { ok: false, error: 'endpoint : nom d\'hôte non public refusé' }
  }

  return { ok: true, endpoint: url.toString() }
}
