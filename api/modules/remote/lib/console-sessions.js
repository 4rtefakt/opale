import crypto from 'crypto'
import { SessionBuffer } from './session-buffer.js'
import { attachSystemEventToOpenTicketsOfDevice } from '../../tickets/lib/ticket-events.js'
import { logAudit } from '../../core/lib/audit.js'

// Registry des sessions console-via-agent actives. Une "session" lie un
// admin (browser WS) à un agent (WS persistant) via un session_id qui
// multiplexe les frames `console.*` sur le tube agent.
//
// Policy enforcée ici : **une seule session active par device**. Une
// deuxième tentative reçoit un erreur de conflit ; l'admin peut forcer
// via le flag `takeover=true` sur le grant, qui kill l'ancienne et logge
// un audit `agent_console_takeover`.
//
// Stockage en mémoire (cohérent avec agent-ws et avec le déploiement
// mono-instance). Le close-on-agent-disconnect est câblé en listener
// du `agentWs.on('disconnect')` — un agent qui perd le WS perd toutes
// ses sessions instantanément (pas de tentative de "résume", cf. design
// doc PR 2).

export const CONSOLE_DEFAULT_SHELL = 'powershell.exe'
export const CONSOLE_OPEN_TIMEOUT_MS = 5_000  // côté agent : spawn ConPTY < 5s

export class ConsoleConflictError extends Error {
  constructor(holder) {
    super('console session already active on device')
    this.holder = holder  // { by_name, by_entra_id, started_at }
    this.code = 'CONSOLE_CONFLICT'
  }
}

export class ConsoleSessionsRegistry {
  constructor({ log, db, agentWs }) {
    this.log = log
    this.db  = db
    this.sessions = new Map()  // sessionId → session
    this.byDevice = new Map()  // deviceId → sessionId

    // Si l'agent perd sa WS, toutes ses sessions sont caduques (le ConPTY
    // est dead côté Windows une fois le tube tombé — cf. agent-go/ws.go).
    agentWs.on('disconnect', (deviceId) => {
      this._closeByDevice(deviceId, 'agent-disconnected')
    })
  }

  findActiveByDevice(deviceId) {
    const sid = this.byDevice.get(deviceId)
    return sid ? this.sessions.get(sid) : null
  }

  get(sessionId) { return this.sessions.get(sessionId) || null }

  count() { return this.sessions.size }

  // Crée + persiste une session. Lève ConsoleConflictError si une session
  // est déjà active sur ce device (sauf si takeoverOf est passé, auquel cas
  // l'appelant a déjà fermé l'ancienne).
  async create({ deviceId, agentConn, browserSocket, identity, shell, takeoverOf }) {
    if (this.byDevice.has(deviceId)) {
      const holder = this.findActiveByDevice(deviceId)
      throw new ConsoleConflictError({
        by_name:     holder?.identity?.displayName || null,
        by_entra_id: holder?.identity?.entraId    || null,
        started_at:  holder ? new Date(holder.startedAt).toISOString() : null,
      })
    }
    const sessionId = crypto.randomUUID()
    const shellPath = shell || CONSOLE_DEFAULT_SHELL

    await this.db.query(
      `INSERT INTO remote_sessions
       (id, device_id, transport, by_entra_id, by_name, shell, takeover_of)
       VALUES ($1, $2, 'agent_console', $3, $4, $5, $6)`,
      [sessionId, deviceId, identity.entraId, identity.displayName, shellPath, takeoverOf || null]
    )

    const startedAt = Date.now()
    const session = {
      id:           sessionId,
      deviceId,
      agentConn,
      browserSocket,
      identity,
      shell:        shellPath,
      startedAt,
      // Capture stdin/stdout en mémoire pendant la session, flush unique à
      // la fermeture (cf. lib/session-buffer.js). Très sensible RGPD :
      // contient le contenu intégral du terminal (mots de passe affichés,
      // données users). Rétention 30 j via plugins/cleanup.js.
      buffer:       new SessionBuffer({ startedAt }),
      // Côté browser : on multiplexe le sessionId pour rester cohérent
      // avec le protocole agent, même si un seul socket = une seule session.
      sendBrowser:  (type, data) => {
        if (browserSocket.readyState !== 1) return false
        try {
          browserSocket.send(JSON.stringify({ type, data }))
          return true
        } catch { return false }
      },
    }
    this.sessions.set(sessionId, session)
    this.byDevice.set(deviceId, sessionId)
    return session
  }

  // Ferme proprement : send console.close à l'agent (best-effort), ferme le
  // browser socket, met à jour la row DB. Idempotent.
  async close(sessionId, reason) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    if (this.byDevice.get(s.deviceId) === sessionId) this.byDevice.delete(s.deviceId)

    // Notifie l'agent que la session est terminée (kill ConPTY côté lui).
    s.agentConn?.send('console.close', { reason }, sessionId)

    try { s.browserSocket.close(1000, reason.slice(0, 120)) } catch {}

    // Flush du buffer AVANT l'UPDATE ended_at : on veut que le log soit
    // visible dès que la row est marquée fermée. Un flush qui échoue ne
    // doit pas bloquer la fermeture — on log et on continue.
    if (s.buffer) {
      await s.buffer.flush(this.db, sessionId)
        .catch(err => this.log.warn({ err: err.message, sessionId }, 'remote_session_logs flush failed'))
    }

    const durationSeconds = Math.round((Date.now() - s.startedAt) / 1000)

    await this.db.query(
      `UPDATE remote_sessions
         SET ended_at = now(), end_reason = $1
       WHERE id = $2 AND ended_at IS NULL`,
      [reason, sessionId]
    ).catch(err => this.log.warn({ err: err.message, sessionId }, 'remote_session close update failed'))

    // Audit log de fin de session avec durée (event distinct de
    // `agent_console_open` côté routes/console.js).
    logAudit(this.db, this.log, {
      action: 'agent_console_close',
      byUser: s.identity.displayName,
      target: s.deviceId,
      details: { session_id: sessionId, reason, duration_seconds: durationSeconds, shell: s.shell },
    })

    // Trace de fermeture dans les tickets ouverts/en cours du device. Pair
    // avec l'event open inséré dans routes/console.js — l'admin voit le
    // début + la durée dans le fil du ticket.
    attachSystemEventToOpenTicketsOfDevice(
      this.db,
      s.deviceId,
      s.identity.displayName,
      `🖥 Console SYSTEM fermée — durée ${formatDuration(durationSeconds)}`
    ).catch(err => this.log.warn({ err: err.message, sessionId }, 'console close ticket event failed'))
  }

  _closeByDevice(deviceId, reason) {
    const sid = this.byDevice.get(deviceId)
    if (sid) this.close(sid, reason).catch(() => {})
  }
}

// Format durée court (ex: "3 min 12 s", "47 s", "1 h 5 min"). Utilisé dans
// le contenu des ticket_messages d'événement (visible côté UI).
function formatDuration(s) {
  if (s == null || !Number.isFinite(s)) return ''
  if (s < 60)   return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h} h ${m} min`
}
