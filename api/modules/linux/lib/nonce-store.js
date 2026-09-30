// RAM mono-instance, comme one-shot-grant : un redémarrage oublie les nonces.
export function createNonceStore({ ttlMs = 600_000, max = 50_000, now = () => Date.now() } = {}) {
  const nonces = new Map()
  let accesses = 0

  function has(id) {
    const time = now()
    if (++accesses % 100 === 0) {
      for (const [key, expiresAt] of nonces) {
        if (expiresAt <= time) nonces.delete(key)
      }
    }
    const expiresAt = nonces.get(id)
    if (expiresAt === undefined) return false
    if (expiresAt <= time) {
      nonces.delete(id)
      return false
    }
    return true
  }

  return {
    // Consultation sans écriture avant crypto.verify ; seen ne suit qu'un succès.
    has,
    seen(id) {
      if (has(id)) return true
      nonces.set(id, now() + ttlMs)
      if (nonces.size > max) nonces.delete(nonces.keys().next().value)
      return false
    },
  }
}
