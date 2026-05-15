import { generateChecklist } from '../lib/onboarding-templates.js'
import {
  createEntraUser, disableEntraUser,
  addUserToGroup, revokeUserSessions
} from '../../core/lib/graph.js'

export default async function onboardingRoute(fastify) {

  // GET /api/onboarding?kind=&status=
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { kind, status } = req.query
    const conds = []; const params = []; let i = 1
    if (kind)   { conds.push(`kind = $${i++}`);   params.push(kind) }
    if (status) { conds.push(`status = $${i++}`); params.push(status) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const { rows } = await fastify.db.query(`
      SELECT o.*,
        COUNT(c.id)::int                                     AS total_checks,
        COUNT(c.id) FILTER (WHERE c.done)::int               AS done_checks
      FROM onboardings o
      LEFT JOIN onboarding_checks c ON c.onboarding_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.start_date DESC NULLS LAST, o.created_at DESC
    `, params)
    reply.send(rows)
  })

  // POST /api/onboarding
  fastify.post('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const {
      person_name, email, role, contract_type, department,
      start_date, end_date, kind = 'onboard',
      manager_name, manager_entra_id, notes
    } = req.body || {}

    if (!person_name) return reply.code(400).send({ error: 'Nom requis' })

    const { entraId, displayName } = fastify.getUserIdentity(req)

    const { rows } = await fastify.db.query(`
      INSERT INTO onboardings
        (person_name, email, role, contract_type, department,
         start_date, end_date, kind,
         manager_name, manager_entra_id, notes,
         by_entra_id, by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [person_name, email||null, role||null, contract_type||null, department||null,
        start_date||null, end_date||null, kind,
        manager_name||null, manager_entra_id||null, notes||null,
        entraId, displayName])

    const onboarding = rows[0]

    // Générer la checklist
    const steps = generateChecklist(kind)
    for (const step of steps) {
      await fastify.db.query(`
        INSERT INTO onboarding_checks (onboarding_id, step_id, label, section, is_auto)
        VALUES ($1,$2,$3,$4,$5)
      `, [onboarding.id, step.step_id, step.label, step.section, step.is_auto])
    }

    reply.code(201).send(onboarding)
  })

  // GET /api/onboarding/:id
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.db.query(
      'SELECT * FROM onboardings WHERE id = $1', [req.params.id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'Onboarding introuvable' })

    const { rows: checks } = await fastify.db.query(`
      SELECT * FROM onboarding_checks WHERE onboarding_id = $1
      ORDER BY section, label
    `, [req.params.id])

    reply.send({ ...rows[0], checks })
  })

  // PATCH /api/onboarding/:id
  fastify.patch('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const allowed = ['person_name','email','role','contract_type','department',
                     'start_date','end_date','manager_name','manager_entra_id','notes',
                     'status','entra_id_created']
    const fields = []; const params = []; let i = 1
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        fields.push(`${key} = $${i++}`)
        params.push(req.body[key])
      }
    }
    if (!fields.length) return reply.code(400).send({ error: 'Aucun champ à modifier' })
    params.push(req.params.id)
    const { rows } = await fastify.db.query(
      `UPDATE onboardings SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
      params
    )
    if (!rows.length) return reply.code(404).send({ error: 'Onboarding introuvable' })
    reply.send(rows[0])
  })

  // DELETE /api/onboarding/:id
  fastify.delete('/:id', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    await fastify.db.query('DELETE FROM onboardings WHERE id = $1', [req.params.id])
    reply.code(204).send()
  })

  // PATCH /api/onboarding/:id/checks/:checkId — toggle manuel
  fastify.patch('/:id/checks/:checkId', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { done } = req.body || {}
    const { displayName } = fastify.getUserIdentity(req)
    const { rows } = await fastify.db.query(`
      UPDATE onboarding_checks
      SET done = $1, done_at = $2, done_by = $3, updated_at = now()
      WHERE id = $4 AND onboarding_id = $5
      RETURNING *
    `, [done, done ? new Date() : null, done ? displayName : null,
        req.params.checkId, req.params.id])
    if (!rows.length) return reply.code(404).send({ error: 'Étape introuvable' })

    // Mettre à jour statut global si toutes les étapes sont faites
    await updateOnboardingStatus(fastify, req.params.id)
    reply.send(rows[0])
  })

  // POST /api/onboarding/:id/checks/:checkId/auto — déclencher l'automatisation
  fastify.post('/:id/checks/:checkId/auto', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: chRows } = await fastify.db.query(
      'SELECT * FROM onboarding_checks WHERE id = $1 AND onboarding_id = $2',
      [req.params.checkId, req.params.id]
    )
    if (!chRows.length) return reply.code(404).send({ error: 'Étape introuvable' })
    const check = chRows[0]

    const { rows: oRows } = await fastify.db.query(
      'SELECT * FROM onboardings WHERE id = $1', [req.params.id]
    )
    const ob = oRows[0]
    const { displayName } = fastify.getUserIdentity(req)

    let result = null
    let error  = null

    try {
      result = await runAutomation(check.step_id, ob, fastify)

      // Sauvegarder le résultat éventuel (ex: mot de passe temporaire)
      if (result?.id && check.step_id === 'create_account') {
        await fastify.db.query(
          'UPDATE onboardings SET entra_id_created = $1, updated_at = now() WHERE id = $2',
          [result.id, ob.id]
        )
      }
      if (result?.temporaryPassword) {
        const note = `Compte créé : ${result.userPrincipalName}\nMot de passe temporaire : ${result.temporaryPassword}`
        await fastify.db.query(
          'UPDATE onboardings SET notes = COALESCE(notes || E\'\\n\', \'\') || $1 WHERE id = $2',
          [note, ob.id]
        )
      }
    } catch (err) {
      error = err.message
      fastify.log.warn({ err: err.message, step: check.step_id }, 'Automatisation échouée')
    }

    const { rows: updated } = await fastify.db.query(`
      UPDATE onboarding_checks
      SET done = $1, done_at = $2, done_by = $3,
          auto_result = $4, auto_error = $5, updated_at = now()
      WHERE id = $6 RETURNING *
    `, [!error, error ? null : new Date(), displayName,
        error ? null : JSON.stringify(result), error,
        req.params.checkId])

    await updateOnboardingStatus(fastify, req.params.id)

    if (error) return reply.code(500).send({ error, check: updated[0] })
    reply.send({ check: updated[0], result })
  })
}

async function runAutomation(stepId, ob, fastify) {
  switch (stepId) {
    case 'create_account': {
      if (!ob.email) throw new Error('Email requis pour créer le compte')
      return createEntraUser({
        displayName:       ob.person_name,
        userPrincipalName: ob.email,
        jobTitle:          ob.role,
        department:        ob.department
      })
    }

    case 'assign_license': {
      const groupId = process.env.ONBOARDING_LICENSE_GROUP_ID
      if (!groupId) throw new Error('ONBOARDING_LICENSE_GROUP_ID non défini')
      const userId = ob.entra_id_created
      if (!userId) throw new Error('Compte Entra pas encore créé (étape create_account requise)')
      return addUserToGroup(userId, groupId)
    }

    case 'assign_groups': {
      const ids = (process.env.ONBOARDING_BASE_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!ids.length) throw new Error('ONBOARDING_BASE_GROUP_IDS non défini')
      const userId = ob.entra_id_created
      if (!userId) throw new Error('Compte Entra pas encore créé (étape create_account requise)')
      for (const gid of ids) await addUserToGroup(userId, gid)
      return { addedToGroups: ids.length }
    }

    case 'disable_account': {
      const userId = ob.entra_id_created
      if (!userId) throw new Error('entra_id_created non renseigné sur cet onboarding')
      return disableEntraUser(userId)
    }

    case 'revoke_sessions': {
      const userId = ob.entra_id_created
      if (!userId) throw new Error('entra_id_created non renseigné sur cet onboarding')
      return revokeUserSessions(userId)
    }

    default:
      throw new Error(`Automatisation non disponible pour l'étape "${stepId}"`)
  }
}

async function updateOnboardingStatus(fastify, id) {
  const { rows } = await fastify.db.query(
    'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE done)::int AS done FROM onboarding_checks WHERE onboarding_id = $1',
    [id]
  )
  const { total, done } = rows[0]
  if (total > 0 && done === total) {
    await fastify.db.query(
      "UPDATE onboardings SET status = 'done', updated_at = now() WHERE id = $1 AND status != 'done'",
      [id]
    )
  }
}
