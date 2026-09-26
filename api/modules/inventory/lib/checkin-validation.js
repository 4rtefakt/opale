// Validation serveur des champs remontés par l'agent au checkin. L'agent
// (ou un token volé) est une source non fiable : ces valeurs sont réutilisées
// côté serveur (ip_netbird = cible des connexions SSH / scripts lancées par
// l'API) et affichées dans l'UI.
//
// Compatibilité : les valeurs légitimes envoyées par l'agent Go actuel
// (agent-go/metrics_windows.go + helpers_unix.go : classifyAdapter,
// pickNetbirdIP) restent acceptées telles quelles.

import net from 'node:net'

// Plage CGNAT dans laquelle Netbird attribue les IP de ses pairs.
const NETBIRD_RANGE = new net.BlockList()
NETBIRD_RANGE.addSubnet('100.64.0.0', 10, 'ipv4')

// true si `ip` est une IPv4 de 100.64.0.0/10.
export function isNetbirdIp(ip) {
  return typeof ip === 'string' && net.isIPv4(ip) && NETBIRD_RANGE.check(ip, 'ipv4')
}

// Types d'interface produits par classifyAdapter côté agent, et seuls
// distingués par l'UI (icône wifi / réseau / prise).
export const IFACE_TYPES = new Set(['eth', 'wifi', 'netbird'])

// Type d'interface normalisé : absent → 'eth' (défaut historique du
// checkin) ; valeur hors liste → null (valeur ignorée, pas stockée).
export function normalizeIfaceType(type) {
  if (type === undefined || type === null || type === '') return 'eth'
  if (typeof type !== 'string') return null
  const t = type.trim().toLowerCase()
  return IFACE_TYPES.has(t) ? t : null
}

// Chaîne bornée pour les logs / l'audit. Tolère n'importe quelle valeur JSON
// (String() lève sur un objet `{ "toString": "x" }` envoyé par un client).
export function clipStr(value, max) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max)
  return `[${Array.isArray(value) ? 'array' : typeof value}]`
}

// Tronque `text` au milieu pour tenir en `maxBytes` octets UTF-8 : garde le
// début et la fin (en-tête et erreur finale d'un log d'installation), avec
// un marqueur indiquant la taille d'origine. Ne coupe jamais un caractère.
export function truncateMiddle(text, maxBytes) {
  const total = Buffer.byteLength(text, 'utf8')
  if (total <= maxBytes) return text
  const marker = `\n… [log tronqué : ${total} octets au total, milieu omis] …\n`
  const room = maxBytes - Buffer.byteLength(marker, 'utf8')
  const headBytes = Math.ceil(room / 2)
  const tailBytes = room - headBytes
  const buf = Buffer.from(text, 'utf8')
  // Un caractère multi-octets coupé se décode en U+FFFD : on le retire.
  const head = buf.subarray(0, headBytes).toString('utf8').replace(/\uFFFD+$/, '')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8').replace(/^\uFFFD+/, '')
  return head + marker + tail
}
