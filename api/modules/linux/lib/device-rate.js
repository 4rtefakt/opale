// Limite par device appliquée dans les handlers après vérification de la
// signature (docs/linux-fleet-design.md §1 : les limites du plugin sont par
// IP seule). Fenêtre glissante en RAM, mono-instance ; sans minuteur : les
// horodatages périmés sont élagués à chaque passage, et la table entière
// quand elle atteint `maxEntries`.

export function createDeviceRateLimiter({ max, windowMs, now = Date.now, maxEntries = 10_000 } = {}) {
  const hits = new Map()
  const prune = (list, since) => { while (list.length && list[0] <= since) list.shift() }
  const sweep = since => {
    for (const [id, list] of hits) {
      prune(list, since)
      if (!list.length) hits.delete(id)
    }
  }
  return {
    // { ok: true, remaining } ou { ok: false, retry_after_ms } (le passage refusé n'est pas compté).
    hit(id) {
      const t = now()
      const since = t - windowMs
      if (hits.size >= maxEntries && !hits.has(id)) sweep(since)
      let list = hits.get(id)
      if (!list) hits.set(id, list = [])
      prune(list, since)
      if (list.length >= max) return { ok: false, retry_after_ms: list[0] + windowMs - t }
      list.push(t)
      return { ok: true, remaining: max - list.length }
    },
    size() {
      sweep(now() - windowMs)
      return hits.size
    },
  }
}
