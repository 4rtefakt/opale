// api/lib/one-shot-grant.js
//
// Store one-shot pour grants SSH/console : un nonce hex 32 octets consommé
// une seule fois pour upgrader un WebSocket sans passer le JWT en query
// string (le JWT fuite via Referer, caches HTTP, access logs Caddy).
//
// Stockage en RAM, mono-instance — cohérent avec le déploiement actuel.
// Pour scale-out, swap pour Redis SETEX (la signature publique tient).
//
// Usage :
//   const store = createGrantStore({ ttlMs: 30_000 })
//   const { nonce, expires_in } = store.create({ deviceId, identity, reason })
//   const { ok, grant, error } = store.consume(nonce)
//
// `consume` retire le nonce du store même en cas d'erreur — une tentative
// d'upgrade WS avec un nonce invalide ne doit pas permettre un retry.

import crypto from 'crypto'

export function createGrantStore({ ttlMs = 30_000 } = {}) {
  const grants = new Map()

  return {
    create(payload = {}) {
      const nonce = crypto.randomBytes(32).toString('hex')
      const expiresAt = Date.now() + ttlMs
      grants.set(nonce, { ...payload, expiresAt })
      // Auto-cleanup même si jamais consommé (browser fermé après /grant)
      setTimeout(() => grants.delete(nonce), ttlMs).unref()
      return { nonce, expires_in: ttlMs / 1000 }
    },

    consume(nonce) {
      if (typeof nonce !== 'string' || !nonce) {
        return { ok: false, error: 'Nonce manquant' }
      }
      const grant = grants.get(nonce)
      grants.delete(nonce)  // one-shot, même en cas d'échec
      if (!grant) return { ok: false, error: 'Nonce invalide ou déjà utilisé' }
      if (grant.expiresAt < Date.now()) return { ok: false, error: 'Nonce expiré' }
      return { ok: true, grant }
    },

    // Exposé pour les tests + futur monitoring.
    size() { return grants.size },
  }
}
