export default async function stockRoute(fastify) {

  // GET /api/stock?q=&category=
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q:        { type: 'string', maxLength: 200 },
          category: { type: 'string', maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { q, category } = req.query
    const conds = []
    const params = []
    let i = 1

    if (q)        { conds.push(`name ILIKE $${i++}`);     params.push(`%${q}%`) }
    if (category) { conds.push(`category = $${i++}`);     params.push(category) }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const { rows } = await fastify.db.query(
      `SELECT * FROM stock_items ${where} ORDER BY name ASC`,
      params
    )
    reply.send(rows)
  })

  // POST /api/stock
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 200 },
          category:    { type: 'string', maxLength: 100 },
          quantity:    { type: 'integer', minimum: 0, default: 0 },
          threshold:   { type: 'integer', minimum: 0, default: 2 },
          unit:        { type: 'string', maxLength: 20, default: 'pcs' },
          description: { type: 'string', maxLength: 1000 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { name, category, quantity = 0, threshold = 2, unit = 'pcs', description } = req.body

    const { rows } = await fastify.db.query(`
      INSERT INTO stock_items (name, category, quantity, alert_threshold, threshold, unit, description)
      VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING *
    `, [name, category || null, parseInt(quantity, 10), parseInt(threshold, 10), unit, description || null])

    reply.code(201).send(rows[0])
  })

  // PATCH /api/stock/:id
  fastify.patch('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 200 },
          category:    { type: 'string', maxLength: 100 },
          threshold:   { type: 'integer', minimum: 0 },
          unit:        { type: 'string', maxLength: 20 },
          description: { type: 'string', maxLength: 1000 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { name, category, threshold, unit, description } = req.body || {}
    const fields = []
    const params = []
    let i = 1

    if (name !== undefined)        { fields.push(`name = $${i++}`);           params.push(name) }
    if (category !== undefined)    { fields.push(`category = $${i++}`);       params.push(category) }
    if (threshold !== undefined)   {
      fields.push(`threshold = $${i}, alert_threshold = $${i}`)
      i++
      params.push(parseInt(threshold, 10))
    }
    if (unit !== undefined)        { fields.push(`unit = $${i++}`);           params.push(unit) }
    if (description !== undefined) { fields.push(`description = $${i++}`);   params.push(description) }

    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })

    params.push(req.params.id)
    const { rows } = await fastify.db.query(
      `UPDATE stock_items SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
      params
    )
    if (!rows.length) return reply.code(404).send({ error: 'Article introuvable' })
    reply.send(rows[0])
  })

  // POST /api/stock/:id/movements
  fastify.post('/:id/movements', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['type', 'quantity'],
        properties: {
          type:      { type: 'string', enum: ['in', 'out'] },
          quantity:  { type: 'integer', minimum: 1 },
          note:      { type: 'string', maxLength: 500 },
          device_id: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { type, quantity, note, device_id } = req.body
    // type et quantity sont validés par le schéma (requis + enum + minimum 1)

    const qty = parseInt(quantity, 10)
    const { entraId, displayName } = fastify.getUserIdentity(req)

    const { rows: items } = await fastify.db.query('SELECT * FROM stock_items WHERE id = $1', [req.params.id])
    if (!items.length) return reply.code(404).send({ error: 'Article introuvable' })

    if (type === 'out' && items[0].quantity < qty) {
      return reply.code(409).send({ error: 'Stock insuffisant' })
    }

    const delta = type === 'in' ? qty : -qty

    const { rows: mvt } = await fastify.db.query(`
      INSERT INTO stock_movements (item_id, type, quantity, note, device_id, user_id, by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req.params.id, type, qty, note || null, device_id || null, entraId, displayName])

    const { rows: updated } = await fastify.db.query(`
      UPDATE stock_items
      SET quantity = quantity + $1, last_movement_at = now(), updated_at = now()
      WHERE id = $2 RETURNING *
    `, [delta, req.params.id])

    reply.code(201).send({ movement: mvt[0], item: updated[0] })
  })

  // GET /api/stock/:id/movements
  fastify.get('/:id/movements', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { rows } = await fastify.db.query(`
      SELECT m.*, d.hostname
      FROM stock_movements m
      LEFT JOIN devices d ON d.id = m.device_id
      WHERE m.item_id = $1
      ORDER BY COALESCE(m.created_at, m.date) DESC
      LIMIT 50
    `, [req.params.id])
    reply.send(rows)
  })
}
