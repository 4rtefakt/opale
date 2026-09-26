// fetch vers Microsoft Graph (et l'endpoint de token Entra) avec :
//
//   - un timeout (AbortSignal.timeout) : sans lui, un Graph qui ne répond pas
//     bloquait indéfiniment la requête HTTP appelante, ou le tick d'un worker
//     — et donc, avec la garde anti-chevauchement, tous les ticks suivants ;
//
//   - une reprise bornée sur 429 (throttling Graph) en respectant
//     Retry-After (secondes ou date HTTP ; à défaut 1 s, 2 s, 4 s). Une 429
//     garantit que la requête n'a pas été traitée : la rejouer est sûr, même
//     pour un POST (sendMail). Les autres statuts, 503 compris, ne sont PAS
//     rejoués : un POST aurait pu être traité. Retry-After au-delà de
//     maxRetryAfterMs → pas d'attente démesurée, la 429 est rendue.
//
// La réponse finale (y compris une 429 non rejouée) est rendue telle quelle :
// chaque appelant garde sa gestion d'erreur. Un timeout lève une Error
// « Graph : pas de réponse en N ms ».
//
// fetch est résolu à l'appel (globalThis.fetch, ou opts.fetchImpl) : les
// tests qui remplacent globalThis.fetch continuent de fonctionner.

export const graphFetchDefaults = {
  timeoutMs: 30_000,
  maxRetries: 3,             // au plus 3 reprises (4 tentatives)
  maxRetryAfterMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// Délai d'attente avant la reprise n° attempt (0-based).
export function retryAfterMs(header, attempt, now = Date.now()) {
  const v = header == null ? '' : String(header).trim()
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000
  if (v) {
    const at = Date.parse(v)
    if (!Number.isNaN(at)) return Math.max(0, at - now)
  }
  return 1000 * 2 ** attempt
}

export async function graphFetch(url, init = {}, opts = {}) {
  const { timeoutMs, maxRetries, maxRetryAfterMs, sleep } = { ...graphFetchDefaults, ...opts }
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    let res
    try {
      res = await fetchImpl(url, { ...init, signal })
    } catch (err) {
      if (err?.name === 'TimeoutError' || timeout.aborted) {
        throw new Error(`Graph : pas de réponse en ${timeoutMs} ms`, { cause: err })
      }
      throw err
    }
    if (res.status !== 429 || attempt >= maxRetries) return res

    const waitMs = retryAfterMs(res.headers?.get?.('retry-after'), attempt)
    if (waitMs > maxRetryAfterMs) return res
    // Libère la connexion de la réponse abandonnée avant d'attendre.
    try { await res.body?.cancel?.() } catch { /* corps déjà consommé */ }
    await sleep(waitMs)
  }
}
