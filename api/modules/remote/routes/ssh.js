import { Client } from 'ssh2'
import { SessionBuffer } from '../lib/session-buffer.js'
import { parseReason, formatReasonLine } from '../lib/remote-reason.js'
import { attachSystemEventToOpenTicketsOfDevice } from '../../tickets/lib/ticket-events.js'
import { logAudit } from '../../core/lib/audit.js'
import { createGrantStore } from '../lib/one-shot-grant.js'

function sshKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64
  if (!b64) throw new Error('SSH_PRIVATE_KEY_B64 non défini')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// Grants SSH one-shot : un admin obtient un nonce via POST /grant (auth JWT
// en header Authorization), puis ouvre le WebSocket avec ?nonce=...
// Le nonce est consommé une fois et expire en 30s. Ça évite de passer le JWT
// Entra (durée ~1h, scopes admin) en query string où il fuit via les logs
// proxy (Caddy), Referer, et caches HTTP.
const grants = createGrantStore()

export default async function sshRoute(fastify) {

  // POST /api/ssh/grant — émet un nonce one-shot pour ouvrir un terminal SSH.
  // Auth JWT en header (le pattern propre, vs la query string du WS upgrade).
  fastify.post('/grant', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const { deviceId } = req.body || {}
    if (!deviceId) return reply.code(400).send({ error: 'deviceId requis' })

    // Motif obligatoire (RGPD / traçabilité), même validation que /console/grant.
    const parsed = parseReason(req.body?.reason)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const reason = parsed.reason

    const { rows } = await fastify.db.query(
      'SELECT id FROM devices WHERE id = $1', [deviceId]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Poste introuvable' })

    const identity = fastify.getUserIdentity(req)
    const { nonce, expires_in } = grants.create({
      deviceId,
      entraId:     identity.entraId,
      displayName: identity.displayName,
      reason,
    })

    reply.send({ nonce, expires_in })
  })

  // WebSocket terminal : GET /api/ssh/:deviceId?nonce=...
  // Le nonce a été obtenu via POST /grant. Consommé une fois, expire en 30s.
  fastify.get('/:deviceId', { websocket: true }, async (socket, req) => {
    const send = (type, data) => {
      if (socket.readyState !== 1) return
      socket.send(JSON.stringify({ type, data }))
    }

    const { ok, grant, error } = grants.consume(req.query.nonce)
    if (!ok) { send('error', error); socket.close(); return }

    if (grant.deviceId !== req.params.deviceId) {
      send('error', 'Nonce ne correspond pas au poste'); socket.close(); return
    }

    const identity = { entraId: grant.entraId, displayName: grant.displayName }
    const reason   = grant.reason

    // Récupérer l'IP du poste
    const { rows: devices } = await fastify.db.query(
      'SELECT id, hostname, ip_netbird FROM devices WHERE id = $1', [req.params.deviceId]
    )
    if (!devices.length || !devices[0].ip_netbird) {
      send('error', 'Poste introuvable ou IP Netbird manquante'); socket.close(); return
    }
    const device = devices[0]

    // Journaliser la session dans la table unifiée remote_sessions (cf.
    // migration 046). La console-via-agent écrit dans la même table avec
    // transport='agent_console'.
    const startedAt = Date.now()
    const { rows: session } = await fastify.db.query(`
      INSERT INTO remote_sessions (device_id, transport, by_entra_id, by_name, ip)
      VALUES ($1, 'ssh', $2, $3, $4) RETURNING id
    `, [device.id, identity.entraId, identity.displayName, device.ip_netbird])
    const sessionId = session[0].id

    // Capture stdin/stdout/stderr en mémoire, flush unique en fin de session
    // (cf. lib/session-buffer.js). Données très sensibles RGPD — rétention
    // 30 j gérée par plugins/cleanup.js.
    const buffer = new SessionBuffer({ startedAt })

    // Audit log d'ouverture — inclut le motif tapé au grant (cf. RGPD).
    logAudit(fastify.db, fastify.log, {
      action:  'ssh_open',
      byUser:  identity.displayName,
      target:  device.id,
      details: { session_id: sessionId, host: device.hostname, ip: device.ip_netbird, reason },
    })

    // Trace dans les tickets ouverts/en cours du device, en pendant des
    // ticket events console-via-agent. Best-effort.
    attachSystemEventToOpenTicketsOfDevice(
      fastify.db,
      device.id,
      identity.displayName,
      `⌨ SSH ouvert par ${identity.displayName} — motif : ${formatReasonLine(reason)}`
    ).catch(err => fastify.log.warn({ err: err.message, sessionId }, 'ssh open ticket event failed'))

    send('status', `Connexion à ${device.hostname} (${device.ip_netbird})...`)

    const conn = new Client()

    conn.on('ready', () => {
      send('status', 'Connecté')
      conn.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
        if (err) { send('error', err.message); conn.end(); return }

        // Données terminal → client
        stream.on('data', (data) => {
          try { buffer.add('out', data) } catch {}
          send('data', data.toString('base64'))
        })
        stream.stderr.on('data', (data) => {
          try { buffer.add('out', data) } catch {}
          send('data', data.toString('base64'))
        })

        // Données client → terminal
        socket.on('message', (msg) => {
          try {
            const { type, data } = JSON.parse(msg.toString())
            if (type === 'input') {
              const raw = Buffer.from(data, 'base64')
              try { buffer.add('in', raw) } catch {}
              stream.write(raw)
            }
            if (type === 'resize') {
              // Garde-fou contre des valeurs aberrantes ou non-entières envoyées
              // par un client custom (ssh2 fait des checks internes mais on
              // borne explicitement côté serveur).
              const rows = data?.rows
              const cols = data?.cols
              if (Number.isInteger(rows) && Number.isInteger(cols)
                  && rows > 0 && rows <= 1000 && cols > 0 && cols <= 1000) {
                stream.setWindow(rows, cols, 0, 0)
              }
            }
          } catch {}
        })

        stream.on('close', () => conn.end())
      })
    })

    conn.on('error', (err) => send('error', `SSH : ${err.message}`))

    conn.on('close', () => {
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000)
      // Flush du buffer AVANT l'UPDATE ended_at : le log est visible dès
      // que la session est marquée fermée. Échec non bloquant.
      buffer.flush(fastify.db, sessionId)
        .catch(err => fastify.log.warn({ err: err.message, sessionId }, 'remote_session_logs flush failed'))
      fastify.db.query('UPDATE remote_sessions SET ended_at = now() WHERE id = $1', [sessionId]).catch(() => {})
      logAudit(fastify.db, fastify.log, {
        action:  'ssh_close',
        byUser:  identity.displayName,
        target:  device.id,
        details: { session_id: sessionId, duration_seconds: durationSeconds },
      })
      attachSystemEventToOpenTicketsOfDevice(
        fastify.db,
        device.id,
        identity.displayName,
        `⌨ SSH fermé — durée ${formatDuration(durationSeconds)}`
      ).catch(err => fastify.log.warn({ err: err.message, sessionId }, 'ssh close ticket event failed'))
      socket.close()
    })

    socket.on('close', () => conn.end())

    conn.connect({
      host:       device.ip_netbird,
      port:       parseInt(process.env.SSH_PORT || '22', 10),
      username:   process.env.SSH_USER || 'opale',
      privateKey: sshKey(),
      readyTimeout: 10_000
    })
  })
}

// Format durée court — dupliqué côté lib/console-sessions.js. Trois lignes,
// pas la peine d'extraire dans un util partagé pour ça.
function formatDuration(s) {
  if (s == null || !Number.isFinite(s)) return ''
  if (s < 60)   return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h} h ${m} min`
}
