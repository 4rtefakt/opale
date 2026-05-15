import { ConsoleConflictError, CONSOLE_DEFAULT_SHELL } from '../lib/console-sessions.js'
import { parseReason, formatReasonLine } from '../lib/remote-reason.js'
import { attachSystemEventToOpenTicketsOfDevice } from '../../tickets/lib/ticket-events.js'
import { logAudit } from '../../core/lib/audit.js'
import { createGrantStore } from '../lib/one-shot-grant.js'

// Console-via-agent : terminal interactif sur un poste Windows, servi via
// l'agent Go (qui tourne déjà en SYSTEM avec un token authentifié), sans
// passer par SSH+Netbird.
//
// Pattern identique à api/routes/ssh.js pour la délivrance d'un nonce
// one-shot (30s) consommé par le WS upgrade. Le JWT Entra n'est JAMAIS
// passé en query string — il fuirait via Referer, caches HTTP, et access
// logs Caddy.
//
// Différence clé vs SSH : il n'y a pas de socket sortant côté serveur.
// L'agent maintient déjà une WS persistante vers nous (cf. PR 1) ; le
// serveur sert juste de bridge entre la WS du browser et celle de l'agent,
// multiplexées par un `session_id` (UUID = id de la row remote_sessions).
//
// Sécurité :
//   - Bearer admin (JWT Entra + requireAdmin)
//   - Rate-limit 15/min (clé IP+token, comme SSH)
//   - Agent doit être actuellement connecté ET annoncer la capability "console"
//   - Une seule session active par device — admin peut "Prendre la main"
//     avec takeover=true ; audit `agent_console_takeover`
//   - Frame size capped à 64 KiB côté browser → server (anti-DoS)

const FRAME_MAX_BYTES = 64 * 1024
const DEFAULT_COLS = 220
const DEFAULT_ROWS = 50

// Grants en mémoire : { nonce → { deviceId, identity, takeover, expiresAt } }.
// Même contrainte mono-instance que ssh.js — pour scale-out passer en Redis.
const grants = createGrantStore()

export default async function consoleRoute(fastify) {

  // POST /api/console/grant — pré-conditions + émission du nonce.
  fastify.post('/grant', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config:     { rateLimit: { max: 15, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const { deviceId, takeover } = req.body || {}
    if (!deviceId || typeof deviceId !== 'string') {
      return reply.code(400).send({ error: 'deviceId requis' })
    }
    // Motif obligatoire (RGPD / traçabilité). Validé strictement — pas de
    // dégradation silencieuse vers "motif vide" qui défaite tout l'audit.
    const parsed = parseReason(req.body?.reason)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const reason = parsed.reason

    const { rows } = await fastify.db.query(
      'SELECT id FROM devices WHERE id = $1', [deviceId]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Poste introuvable' })

    const conn = fastify.agentWs.get(deviceId)
    if (!conn) {
      return reply.code(409).send({ error: 'Agent non connecté', code: 'AGENT_OFFLINE' })
    }
    if (!conn.capabilities.includes('console')) {
      // Cas typique pendant la fenêtre de fan-out 2.13 → 2.14 : l'agent
      // est sur la version qui a le tube WS (PR 1) mais pas encore la
      // console (PR 2). Le auto-update résout en <15min.
      return reply.code(409).send({
        error: 'Agent ne supporte pas la console (mise à jour en attente)',
        code:  'CAPABILITY_MISSING',
        agent_version: conn.agentVersion || null,
      })
    }

    const holder = fastify.consoleSessions.findActiveByDevice(deviceId)
    if (holder && !takeover) {
      return reply.code(409).send({
        error: 'Une session console est déjà active',
        code:  'CONSOLE_CONFLICT',
        holder: {
          by_name:    holder.identity?.displayName || null,
          started_at: new Date(holder.startedAt).toISOString(),
        }
      })
    }

    const identity = fastify.getUserIdentity(req)
    const { nonce, expires_in } = grants.create({
      deviceId,
      identity:   { entraId: identity.entraId, displayName: identity.displayName },
      takeoverOf: takeover && holder ? holder.id : null,
      reason,
    })

    reply.send({ nonce, expires_in })
  })

  // WS GET /api/console/:deviceId?nonce=... — admin browser.
  fastify.get('/:deviceId', { websocket: true }, async (socket, req) => {
    const sendBrowser = (type, data) => {
      if (socket.readyState !== 1) return
      try { socket.send(JSON.stringify({ type, data })) } catch {}
    }
    const fail = (msg, code = 1008) => {
      sendBrowser('error', msg)
      try { socket.close(code, msg.slice(0, 120)) } catch {}
    }

    const { ok, grant, error } = grants.consume(req.query.nonce)
    if (!ok) return fail(error)
    if (grant.deviceId !== req.params.deviceId) return fail('Nonce ne correspond pas au poste')

    // Re-check agent online + capability : entre grant et WS, l'agent a pu
    // perdre sa connexion (reboot, perte réseau).
    const agentConn = fastify.agentWs.get(grant.deviceId)
    if (!agentConn) return fail('Agent déconnecté entre l\'autorisation et l\'ouverture')
    if (!agentConn.capabilities.includes('console')) {
      return fail('Agent ne supporte pas la console')
    }

    // Takeover : si l'admin a forcé, on kill l'ancienne avant de créer la
    // nouvelle. La fermeture envoie console.close à l'agent (kill ConPTY)
    // et notifie l'autre browser via close WS.
    if (grant.takeoverOf) {
      await fastify.consoleSessions.close(grant.takeoverOf, 'taken-over')
      logAudit(fastify.db, fastify.log, {
        action:  'agent_console_takeover',
        byUser:  grant.identity.displayName,
        target:  grant.deviceId,
        details: { taken_session: grant.takeoverOf },
      })
    }

    // Crée la session (insert remote_sessions + registry).
    let session
    try {
      session = await fastify.consoleSessions.create({
        deviceId:     grant.deviceId,
        agentConn,
        browserSocket: socket,
        identity:     grant.identity,
        shell:        CONSOLE_DEFAULT_SHELL,
        takeoverOf:   grant.takeoverOf,
      })
    } catch (err) {
      if (err instanceof ConsoleConflictError) {
        return fail('Une autre session est devenue active entre-temps')
      }
      fastify.log.error({ err: err.message }, 'console session create failed')
      return fail('Erreur serveur')
    }

    // Audit open — inclut le motif tapé par l'admin au grant.
    logAudit(fastify.db, fastify.log, {
      action:  'agent_console_open',
      byUser:  grant.identity.displayName,
      target:  grant.deviceId,
      details: { session_id: session.id, shell: session.shell, reason: grant.reason },
    })

    // Trace dans les tickets ouverts/en cours concernant ce poste — l'admin
    // qui suit un ticket voit l'intervention sans cross-référencer /audit.
    // Best-effort, n'échoue pas l'ouverture si l'INSERT plante.
    attachSystemEventToOpenTicketsOfDevice(
      fastify.db,
      grant.deviceId,
      grant.identity.displayName,
      `🖥 Console SYSTEM ouverte par ${grant.identity.displayName} — motif : ${formatReasonLine(grant.reason)}`
    ).catch(err => fastify.log.warn({ err: err.message }, 'console open ticket event failed'))

    sendBrowser('status', `Ouverture console (${session.shell})…`)

    // Demande à l'agent d'ouvrir le ConPTY pour cette session_id. La réponse
    // (console.opened ou console.error) sera routée par le dispatcher dans
    // routes/agent.js → consoleSessions[sessionId].sendBrowser(...).
    agentConn.send('console.open', {
      shell: session.shell,
      cols:  DEFAULT_COLS,
      rows:  DEFAULT_ROWS,
    }, session.id)

    // Bridge browser → agent (frames input / resize).
    socket.on('message', (raw) => {
      if (raw.length > FRAME_MAX_BYTES) {
        return fastify.consoleSessions.close(session.id, 'browser-frame-too-large')
      }
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg.type !== 'string') return

      if (msg.type === 'input' && typeof msg.data === 'string') {
        // Capture l'entrée user (frappe terminal) dans le buffer de session
        // AVANT de l'envoyer à l'agent — l'agent fait écho, donc on
        // capturera aussi l'octet en 'out' via le dispatch console.data,
        // mais on veut garder une trace explicite du flux 'in' (ex: un
        // mot de passe tapé n'est pas écho mais reste capturé en 'in').
        try { session.buffer.add('in', Buffer.from(msg.data, 'base64')) } catch {}
        agentConn.send('console.input', { b64: msg.data }, session.id)
      } else if (msg.type === 'resize' && msg.data) {
        const rows = msg.data.rows, cols = msg.data.cols
        if (Number.isInteger(rows) && Number.isInteger(cols)
            && rows > 0 && rows <= 1000 && cols > 0 && cols <= 1000) {
          agentConn.send('console.resize', { cols, rows }, session.id)
        }
      }
    })

    socket.on('close', () => {
      fastify.consoleSessions.close(session.id, 'browser-closed')
        .catch(() => {})
    })
    socket.on('error', (err) => {
      fastify.log.warn({ err: err.message, session_id: session.id }, 'browser console socket error')
    })
  })
}
