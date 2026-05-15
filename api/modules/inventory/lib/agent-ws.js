// Registry des connexions WebSocket persistantes agent ↔ serveur.
//
// Une seule connexion active par device : si un agent ouvre une nouvelle
// connexion alors qu'une précédente est encore enregistrée, l'ancienne est
// fermée avec code 4000 (`superseded`). Couvre les cas reboot, restart
// service, agent qui retente après timeout réseau côté serveur.
//
// Stockage en mémoire — cohérent avec api/routes/ssh.js (grants) et avec
// le déploiement mono-instance actuel. Pour scale-out, passer en
// pub/sub Redis : la même API publique tient.

export const WS_FRAME_MAX_BYTES = 64 * 1024  // garde-fou anti-DoS côté receive

// Codes de fermeture WS custom (range 4000-4999 réservée par RFC 6455).
export const WS_CLOSE = {
  AUTH_FAIL:    4401,  // token absent ou invalide
  SUPERSEDED:   4000,  // remplacé par une nouvelle connexion du même device
  PROTOCOL:     4002,  // frame mal formée ou hors protocole
  HEARTBEAT:    4003,  // pong manquant
  POLICY:       4004,  // règle métier (ex: capability manquante)
}

// Libellé court de la cause d'un close, pour l'audit log. Distingue les flap
// réseau (1006) des fermetures intentionnelles (supersede, heartbeat, etc.).
export function wsReasonFromCode(code) {
  if (code === WS_CLOSE.SUPERSEDED)        return 'superseded'
  if (code === WS_CLOSE.AUTH_FAIL)         return 'auth-fail'
  if (code === WS_CLOSE.PROTOCOL)          return 'protocol-error'
  if (code === WS_CLOSE.HEARTBEAT)         return 'heartbeat-timeout'
  if (code === WS_CLOSE.POLICY)            return 'policy'
  if (code === 1000)                       return 'normal'
  if (code === 1001)                       return 'going-away'
  if (code === 1006)                       return 'tcp-abort'  // flap réseau typique
  if (code === 1011)                       return 'server-error'
  return `ws-code-${code}`
}

export class AgentWSRegistry {
  constructor(log) {
    this.log = log
    this.conns = new Map()  // deviceId → AgentConn
    this.listeners = { connect: [], disconnect: [] }
  }

  on(event, fn) {
    if (!this.listeners[event]) throw new Error(`event inconnu : ${event}`)
    this.listeners[event].push(fn)
  }

  _emit(event, ...args) {
    for (const fn of this.listeners[event] || []) {
      try { fn(...args) }
      catch (err) { this.log.warn({ err: err.message, event }, 'agent-ws listener fail') }
    }
  }

  register(deviceId, conn) {
    const prev = this.conns.get(deviceId)
    if (prev && prev !== conn) {
      // L'ancienne connexion va recevoir le close, mais son onClose côté
      // route ne sait pas que c'est un supersede (le code 4000 arrive
      // au peer, pas localement). On émet donc le disconnect *ici*, avec
      // le bon reason, et on marque la conn pour que son onClose éventuel
      // ne double-émette pas l'audit log.
      prev.auditDisconnectEmitted = true
      this._emit('disconnect', deviceId, prev, { reason: 'superseded', code: WS_CLOSE.SUPERSEDED })
      prev.close(WS_CLOSE.SUPERSEDED, 'superseded')
    }
    this.conns.set(deviceId, conn)
    this._emit('connect', deviceId, conn)
  }

  unregister(deviceId, conn) {
    // Si une nouvelle connexion a déjà pris la place, ne pas la déloger
    // (le supersede a déjà émis le disconnect, cf. register).
    if (this.conns.get(deviceId) !== conn) return
    this.conns.delete(deviceId)
    this._emit('disconnect', deviceId, conn)
  }

  get(deviceId)      { return this.conns.get(deviceId) || null }
  isOnline(deviceId) { return this.conns.has(deviceId) }
  count()            { return this.conns.size }
}

// Wrapper autour du WebSocket bas niveau. Encapsule l'envoi de frames JSON
// au format protocolaire { type, id, data } et la fermeture propre.
export function makeAgentConn(socket, meta) {
  return {
    socket,
    deviceId:     meta.deviceId,
    tokenId:      meta.tokenId,
    hostname:     meta.hostname,
    connectedAt:  Date.now(),
    lastPongAt:   Date.now(),
    capabilities: [],
    agentVersion: null,
    os:           null,
    arch:         null,

    // Envoie une frame JSON. `id` est null hors flux multiplexés (console
    // sessions en PR 2). Retourne false si le socket n'est plus ouvert.
    send(type, data = null, id = null) {
      if (socket.readyState !== 1) return false
      try {
        socket.send(JSON.stringify({ type, id, data }))
        return true
      } catch {
        return false
      }
    },

    close(code = 1000, reason = '') {
      try { socket.close(code, reason) } catch {}
    },
  }
}
