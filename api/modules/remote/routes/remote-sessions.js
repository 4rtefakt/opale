// Lecture de l'historique des sessions remote (SSH legacy + console-via-agent)
// + accès au log capturé d'une session donnée (frames du PTY/shell).
//
// La capture des logs est faite par api/lib/console-sessions.js et
// api/routes/ssh.js / api/routes/console.js (interception du flux pendant la
// session, flush unique au close dans la table `remote_session_logs`).
// Cf. la migration 047_remote_session_logs.sql.
//
// Si la migration 047 n'a pas encore tourné (déploiement transitoire), la
// route /log retourne `{ available: false }` gracieusement pour que l'UI ne
// plante pas.

export default async function remoteSessionsRoute(fastify) {

  // NB : la route GET /api/devices/:deviceId/remote-sessions est déclarée
  // dans routes/devices.js (héritée de la PR console-via-agent #82). Pas
  // de redéclaration ici, ça plantait au boot Fastify avec :
  //   "Method 'GET' already declared for route '/api/devices/...'".

  // GET /api/remote-sessions/:id/log
  // Frames capturées d'une session. Format JSONB : array de
  // { ts_ms, direction: 'in'|'out', b64 }. L'UI les rejoue dans un xterm.
  //
  // Comportement face à l'absence de table (chantier 4 pas encore déployé)
  // ou de row (session non capturée ou trop ancienne) :
  //   - table inexistante  → { available: false, reason: 'feature-not-deployed' }
  //   - row absente        → { available: false, reason: 'no-log-for-session' }
  //   - row présente       → { available: true, frames, truncated, size_bytes }
  fastify.get('/remote-sessions/:id/log', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    // Vérifie que la session existe AVANT de tenter la table de logs : ça
    // évite de prétendre "feature not deployed" si en réalité l'id est faux.
    const { rows: sess } = await fastify.db.query(
      'SELECT id, transport, started_at, ended_at FROM remote_sessions WHERE id = $1',
      [req.params.id]
    )
    if (!sess.length) return reply.code(404).send({ error: 'Session introuvable' })

    try {
      const { rows } = await fastify.db.query(
        'SELECT frames, truncated, size_bytes FROM remote_session_logs WHERE session_id = $1',
        [req.params.id]
      )
      if (!rows.length) {
        return reply.send({
          available: false,
          reason:    'no-log-for-session',
          session:   sess[0],
        })
      }
      reply.send({
        available:  true,
        frames:     rows[0].frames,
        truncated:  rows[0].truncated,
        size_bytes: rows[0].size_bytes,
        session:    sess[0],
      })
    } catch (err) {
      // PG error 42P01 = undefined_table. Cas attendu si la migration 047
      // n'a pas encore été appliquée. Tout autre erreur remonte normalement.
      if (err.code === '42P01') {
        return reply.send({
          available: false,
          reason:    'feature-not-deployed',
          session:   sess[0],
        })
      }
      throw err
    }
  })
}
