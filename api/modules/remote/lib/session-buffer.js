// Buffer mémoire pour la capture des sessions remote (SSH + console-via-agent).
// Une instance par session ; les frames sont accumulées au fil de l'eau et
// flushées en un seul INSERT à la fermeture. Si le process crash en cours
// de session, le buffer est perdu — comportement accepté (cf. design doc).
//
// Caps :
//   - DEFAULT_MAX_FRAMES (10 000) frames OU DEFAULT_MAX_BYTES (5 MB) d'octets
//     bruts décodés. Au-delà : truncated=true et add() devient no-op
//     silencieux. La session continue de bridger normalement (on n'arrête
//     QUE la capture, pas le passage des octets entre browser et agent/SSH).
//
// Le compteur size_bytes mesure les OCTETS BRUTS (pré-base64), pas la taille
// du JSON final stocké en DB. Plus prévisible côté RGPD ("X MB de sortie
// terminal capturée") et stable même si l'encodage de stockage change.

const DEFAULT_MAX_FRAMES = 10_000
const DEFAULT_MAX_BYTES  = 5 * 1024 * 1024

export class SessionBuffer {
  constructor({ startedAt = Date.now(), maxFrames = DEFAULT_MAX_FRAMES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.startedAt = startedAt
    this.maxFrames = maxFrames
    this.maxBytes  = maxBytes
    this.frames    = []
    this.sizeBytes = 0
    this.truncated = false
  }

  // direction ∈ 'in' | 'out'. bytes = Buffer (octets bruts).
  // No-op silencieux après la première saturation des caps.
  add(direction, bytes) {
    if (this.truncated) return
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return
    if (this.frames.length >= this.maxFrames
        || this.sizeBytes + bytes.length > this.maxBytes) {
      this.truncated = true
      return
    }
    this.frames.push({
      ts_ms:     Date.now() - this.startedAt,
      direction,
      b64:       bytes.toString('base64'),
    })
    this.sizeBytes += bytes.length
  }

  // Insert unique. Skip si aucune I/O n'a été capturée (session ouverte mais
  // jamais utilisée). ON CONFLICT DO NOTHING protège contre un double-flush
  // (ex: race browser-closed + agent-disconnected).
  // Libère this.frames après flush pour ne pas retenir le buffer en RAM
  // tant que l'objet session traîne quelque part.
  async flush(db, sessionId) {
    if (this.frames.length === 0) return
    const frames    = this.frames
    const sizeBytes = this.sizeBytes
    const truncated = this.truncated
    this.frames    = []
    this.sizeBytes = 0
    await db.query(
      `INSERT INTO remote_session_logs (session_id, frames, size_bytes, truncated)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, JSON.stringify(frames), sizeBytes, truncated]
    )
  }

  // Abandonne le buffer sans flusher (cas d'erreur d'init où on ne veut pas
  // de row partielle en DB).
  abandon() {
    this.frames    = []
    this.sizeBytes = 0
  }
}
