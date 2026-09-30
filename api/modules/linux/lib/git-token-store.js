// Tokens git de courte durée émis au check-in (docs/linux-fleet-design.md §4) :
// seul le sha256 du token est gardé, en RAM, mono-instance (posture one-shot-grant).
import { createHash, randomBytes } from 'node:crypto'

export function createGitTokenStore({ now = Date.now, sweepMs = 60_000 } = {}) {
  const entries = new Map()
  const hash = token => createHash('sha256').update(token).digest('hex')
  const sweep = () => {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) entries.delete(key)
  }
  const timer = setInterval(sweep, sweepMs)
  timer.unref()
  return {
    create({ deviceId, fingerprint, ttlMs }) {
      const token = 'gt_' + randomBytes(20).toString('hex')
      const expiresAt = now() + ttlMs
      entries.set(hash(token), { deviceId, fingerprint, expiresAt })
      return { token, expiresAt }
    },
    // Entrée (avec `expired: true` une seule fois pour un token périmé, qui est alors retiré) ou null.
    verify(token) {
      if (typeof token !== 'string' || !/^gt_[0-9a-f]{40}$/.test(token)) return null
      const key = hash(token)
      const entry = entries.get(key)
      if (!entry) return null
      const expired = entry.expiresAt <= now()
      if (expired) entries.delete(key)
      return { ...entry, expired }
    },
    revokeDevice(deviceId) {
      for (const [key, entry] of entries) if (entry.deviceId === deviceId) entries.delete(key)
    },
    size() { sweep(); return entries.size },
    stop() { clearInterval(timer); entries.clear() },
  }
}
