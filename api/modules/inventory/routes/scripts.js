import { Client } from 'ssh2'
import { resolveGroupMembers } from '../../groups/lib/groups.js'

function sshKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64
  if (!b64) throw new Error('SSH_PRIVATE_KEY_B64 non défini')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// Exécute un script sur un poste via SSH, stream la sortie via SSE
async function execOnDevice(fastify, device, scriptCode, execId, reply) {
  const send = (type, data) => {
    if (reply.raw.writableEnded) return
    reply.raw.write(`data: ${JSON.stringify({ execId, deviceId: device.id, hostname: device.hostname, type, data })}\n\n`)
  }

  return new Promise((resolve) => {
    const conn = new Client()
    const output = []
    const t0 = Date.now()

    conn.on('ready', () => {
      send('connected', `Connecté à ${device.hostname} (${device.ip_netbird})`)
      conn.exec(scriptCode, { pty: false }, (err, stream) => {
        if (err) {
          send('error', err.message)
          conn.end()
          return resolve({ status: 'error', output: err.message, duration: Date.now() - t0 })
        }
        stream.on('data', (chunk) => {
          const text = chunk.toString()
          output.push(text)
          send('stdout', text)
        })
        stream.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          output.push('[stderr] ' + text)
          send('stderr', text)
        })
        stream.on('close', (code) => {
          conn.end()
          const duration = Date.now() - t0
          const status = code === 0 ? 'success' : 'error'
          send('done', { exitCode: code, duration })
          resolve({ status, output: output.join(''), duration })
        })
      })
    })

    conn.on('error', (err) => {
      send('error', `Connexion SSH échouée : ${err.message}`)
      resolve({ status: 'error', output: err.message, duration: Date.now() - t0 })
    })

    conn.connect({
      host:       device.ip_netbird,
      port:       parseInt(process.env.SSH_PORT || '22', 10),
      username:   process.env.SSH_USER || 'opale',
      privateKey: sshKey(),
      readyTimeout: 10_000
    })
  })
}

export default async function scriptsRoute(fastify) {

  // GET /api/scripts
  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT s.*, COUNT(e.id)::int AS exec_count,
              MAX(e.started_at) AS last_run
       FROM scripts s
       LEFT JOIN script_executions e ON e.script_id = s.id
       GROUP BY s.id
       ORDER BY s.name ASC`
    )
    reply.send(rows)
  })

  // POST /api/scripts
  fastify.post('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { name, description, category, code, shell_type = 'powershell' } = req.body || {}
    if (!name || !code) return reply.code(400).send({ error: 'Nom et code requis' })
    const { entraId, displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      INSERT INTO scripts (name, description, category, code, shell_type, by_entra_id, by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, description || null, category || null, code, shell_type, entraId, displayName])
    reply.code(201).send(rows[0])
  })

  // GET /api/scripts/:id
  fastify.get('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query('SELECT * FROM scripts WHERE id = $1', [req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Script introuvable' })
    const { rows: execs } = await fastify.db.query(`
      SELECT e.*, d.hostname FROM script_executions e
      LEFT JOIN devices d ON d.id = e.device_id
      WHERE e.script_id = $1 ORDER BY e.started_at DESC LIMIT 20
    `, [req.params.id])
    reply.send({ ...rows[0], executions: execs })
  })

  // PUT /api/scripts/:id
  fastify.put('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: check } = await fastify.db.query('SELECT is_builtin FROM scripts WHERE id = $1', [req.params.id])
    if (!check.length) return reply.code(404).send({ error: 'Script introuvable' })
    if (check[0].is_builtin) return reply.code(403).send({ error: 'Script intégré non modifiable' })

    const { name, description, category, code, shell_type } = req.body || {}
    const { displayName } = fastify.getUserIdentity(req)
    const fields = []
    const params = []
    let i = 1
    if (name !== undefined)       { fields.push(`name = $${i++}`);       params.push(name) }
    if (description !== undefined){ fields.push(`description = $${i++}`); params.push(description) }
    if (category !== undefined)   { fields.push(`category = $${i++}`);   params.push(category) }
    if (code !== undefined)       { fields.push(`code = $${i++}`);       params.push(code) }
    if (shell_type !== undefined) { fields.push(`shell_type = $${i++}`); params.push(shell_type) }
    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })
    fields.push(`by_name = $${i++}`, `updated_at = now()`)
    params.push(displayName, req.params.id)
    const { rows } = await fastify.db.query(
      `UPDATE scripts SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    )
    if (!rows.length) return reply.code(404).send({ error: 'Script introuvable' })
    reply.send(rows[0])
  })

  // DELETE /api/scripts/:id
  fastify.delete('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: check } = await fastify.db.query('SELECT is_builtin FROM scripts WHERE id = $1', [req.params.id])
    if (!check.length) return reply.code(404).send({ error: 'Script introuvable' })
    if (check[0].is_builtin) return reply.code(403).send({ error: 'Script intégré non supprimable' })
    await fastify.db.query('DELETE FROM scripts WHERE id = $1', [req.params.id])
    reply.code(204).send()
  })

  // POST /api/scripts/:id/exec — lance sur une liste de postes ou un groupe natif, stream SSE
  // Body : { deviceIds: [...] }  OU  { native_group_id: '<uuid>' }
  fastify.post('/:id/exec', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { deviceIds, native_group_id } = req.body || {}

    if (!native_group_id && (!Array.isArray(deviceIds) || !deviceIds.length)) {
      return reply.code(400).send({ error: 'deviceIds ou native_group_id requis' })
    }

    const { rows: scripts } = await fastify.db.query('SELECT * FROM scripts WHERE id = $1', [req.params.id])
    if (!scripts.length) return reply.code(404).send({ error: 'Script introuvable' })
    const script = scripts[0]

    let targetIds = deviceIds || []
    if (native_group_id) {
      const { devices: groupDevices } = await resolveGroupMembers(fastify.db, native_group_id)
      targetIds = groupDevices.map(d => d.device_id)
      if (!targetIds.length) return reply.code(400).send({ error: 'Groupe natif vide ou ne contient aucun poste' })
    }

    const { rows: devices } = await fastify.db.query(
      `SELECT id, hostname, ip_netbird FROM devices WHERE id = ANY($1::uuid[]) AND ip_netbird IS NOT NULL`,
      [targetIds]
    )
    if (!devices.length) return reply.code(400).send({ error: 'Aucun poste joignable (IP Netbird manquante)' })

    const { entraId, displayName } = fastify.getUserIdentity(req)

    // SSE headers
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders()

    // Créer les entrées d'exécution
    const execIds = {}
    for (const d of devices) {
      const { rows } = await fastify.db.query(`
        INSERT INTO script_executions (script_id, device_id, user_id, by_name, status)
        VALUES ($1,$2,$3,$4,'running') RETURNING id
      `, [script.id, d.id, entraId, displayName])
      execIds[d.id] = rows[0].id
    }

    // Exécution en parallèle sur tous les postes
    await Promise.all(devices.map(async (device) => {
      const execId = execIds[device.id]
      const result = await execOnDevice(fastify, device, script.code, execId, reply)
      await fastify.db.query(`
        UPDATE script_executions
        SET status=$1, output=$2, duration_ms=$3
        WHERE id=$4
      `, [result.status, result.output.slice(0, 100000), result.duration, execId])
    }))

    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`)
      reply.raw.end()
    }
  })

  // GET /api/scripts/:id/executions — historique par script
  fastify.get('/:id/executions', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT e.*, d.hostname FROM script_executions e
      LEFT JOIN devices d ON d.id = e.device_id
      WHERE e.script_id = $1 ORDER BY e.queued_at DESC LIMIT 50
    `, [req.params.id])
    reply.send(rows)
  })

  // POST /api/scripts/:id/run — queue exécution via agent
  fastify.post('/:id/run', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { device_id } = req.body || {}
    if (!device_id) return reply.code(400).send({ error: 'device_id requis' })
    const { entraId, displayName } = fastify.getUserIdentity(req)

    const { rows: scripts } = await fastify.db.query('SELECT * FROM scripts WHERE id = $1', [req.params.id])
    if (!scripts.length) return reply.code(404).send({ error: 'Script introuvable' })
    const script = scripts[0]

    const { rows } = await fastify.db.query(`
      INSERT INTO script_executions
        (script_id, device_id, user_id, by_name, mode, status, script_name, script_content, queued_at)
      VALUES ($1,$2,$3,$4,'agent','pending',$5,$6,now())
      RETURNING *
    `, [script.id, device_id, entraId, displayName, script.name, script.code])

    reply.code(201).send(rows[0])
  })

  // GET /api/scripts/executions/device/:deviceId — historique pour un poste
  fastify.get('/executions/device/:deviceId', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const limit = 20
    const offset = Math.max(0, parseInt(req.query.offset) || 0)
    const { rows } = await fastify.db.query(`
      SELECT e.*, s.name AS script_name_ref,
             COUNT(*) OVER() AS total_count
      FROM script_executions e
      LEFT JOIN scripts s ON s.id = e.script_id
      WHERE e.device_id = $1
      ORDER BY e.queued_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.deviceId, limit, offset])
    reply.send({ rows, total: parseInt(rows[0]?.total_count ?? 0), offset, limit })
  })
}
