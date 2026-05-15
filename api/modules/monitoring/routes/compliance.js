// Endpoints du compliance dashboard.
//
// Trois routes :
//   GET /api/compliance                          — aggregate global par règle + summary parc
//   GET /api/compliance/rules/:rule_id           — drill-down devices pour une règle
//   GET /api/devices/:id/compliance              — résultats d'un device (fiche poste)
//
// Toutes en admin-only : la conformité expose des données techniques
// sensibles sur tout le parc.
//
// Override `agent_seen_recent` : la règle est évaluée au checkin, donc le row
// stocké dit toujours 'pass' pour le device qui vient de checkin. Pour les
// devices qui ne checkin plus, le row reste figé à son dernier verdict.
// → côté API on RECALCULE cette règle à la volée depuis devices.last_seen
//   pour avoir un état toujours frais. Les autres règles n'ont pas ce
//   problème (elles dépendent de signaux remontés par le checkin, donc
//   "frais au dernier checkin" est la donnée correcte).
//
// Routes déclarées en chemin absolu (registered avec prefix '/api' dans
// index.js), pour pouvoir mixer /api/compliance/* ET /api/devices/:id/compliance
// sans dépendre de l'ordre d'enregistrement vs devices.js (cf. pattern
// remote-sessions.js).

import { RULES, RULES_BY_ID } from '../lib/compliance.js'

const AGENT_OFFLINE_HOURS = 24

// Re-évalue la règle agent_seen_recent à partir de devices.last_seen.
// Retourne { status, value? } compatible avec le format en DB.
//
// Critère "managé par agent" = agent_version IS NOT NULL. On ne se fie PAS
// au champ `source` car un device créé par sync Intune avant le 1er checkin
// agent garde `source = 'intune'` même quand l'agent a commencé à checkin
// (l'UPDATE dans /api/agent/checkin ne touche pas à source). Sur la prod
// observée le 2026-05-12, 61 postes avaient agent_version set mais
// source='intune' — ils basculaient à tort en N/A.
function evalAgentSeenRecentFromRow(row) {
  if (!row.agent_version) return { status: 'not_applicable' }
  if (!row.last_seen) return { status: 'fail', value: { hours_since: null } }
  const ageH = (Date.now() - new Date(row.last_seen).getTime()) / 3600000
  return ageH <= AGENT_OFFLINE_HOURS
    ? { status: 'pass', value: { hours_since: Math.round(ageH) } }
    : { status: 'fail', value: { hours_since: Math.round(ageH), max: AGENT_OFFLINE_HOURS } }
}

export default async function complianceRoute(fastify) {

  // GET /api/compliance — aggregate par règle + summary parc.
  fastify.get('/compliance', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    // 1) Count brut par (rule_id, status) sur compliance_results.
    const { rows: agg } = await fastify.db.query(`
      SELECT rule_id, status, COUNT(*)::int AS n
      FROM compliance_results
      GROUP BY rule_id, status
    `)
    const aggMap = new Map() // rule_id → { pass, fail, not_applicable }
    for (const r of agg) {
      if (!aggMap.has(r.rule_id)) aggMap.set(r.rule_id, { pass: 0, fail: 0, not_applicable: 0 })
      aggMap.get(r.rule_id)[r.status] = r.n
    }

    // 2) Devices managés (= ceux qu'on évalue). On compte aussi pour le
    //    summary parc.
    const { rows: devRows } = await fastify.db.query(`
      SELECT id, source, last_seen, agent_version FROM devices
    `)
    const devicesTotal = devRows.length

    // 3) Override agent_seen_recent à la volée (cf. doc en tête de fichier).
    const override = { pass: 0, fail: 0, not_applicable: 0 }
    for (const d of devRows) {
      override[evalAgentSeenRecentFromRow(d).status] += 1
    }
    aggMap.set('agent_seen_recent', override)

    // 4) Construit la réponse rules[] en respectant l'ordre déclaré dans RULES.
    const rules = RULES.map(r => {
      const a = aggMap.get(r.id) || { pass: 0, fail: 0, not_applicable: 0 }
      return {
        id:             r.id,
        label:          r.label,
        severity:       r.severity,
        pass:           a.pass,
        fail:           a.fail,
        not_applicable: a.not_applicable,
        total:          a.pass + a.fail + a.not_applicable,
      }
    })

    // 5) Summary parc : combien de devices entièrement conformes vs en échec
    //    vs jamais évalués. Aggregate par device, en EXCLUANT agent_seen_recent
    //    de la table (sa valeur figée est obsolète pour les devices offline) ;
    //    on rajoute sa contribution live par device.
    const { rows: perDev } = await fastify.db.query(`
      SELECT device_id,
             COUNT(*)                                                         ::int AS row_count,
             COUNT(*) FILTER (WHERE status = 'fail')                          ::int AS fail_count,
             COUNT(*) FILTER (WHERE status = 'fail' AND severity = 'critical')::int AS crit_fail,
             COUNT(*) FILTER (WHERE status = 'fail' AND severity = 'high')    ::int AS high_fail
      FROM compliance_results
      WHERE rule_id <> 'agent_seen_recent'
      GROUP BY device_id
    `)
    const perDevMap = new Map(perDev.map(r => [r.device_id, r]))

    let devicesFullCompliant = 0
    let devicesWithFailures  = 0
    let devicesUnevaluated   = 0
    let critDevices = 0
    let highDevices = 0
    for (const d of devRows) {
      const row = perDevMap.get(d.id)
      const live = evalAgentSeenRecentFromRow(d)              // severity 'medium'
      const liveFail = live.status === 'fail' ? 1 : 0

      if (!row && liveFail === 0) {
        // Aucune éval persistée ET agent non-applicable/à jour → unevaluated.
        devicesUnevaluated += 1
        continue
      }
      const effectiveFails = (row?.fail_count || 0) + liveFail
      if (effectiveFails === 0) {
        devicesFullCompliant += 1
      } else {
        devicesWithFailures += 1
        if ((row?.crit_fail || 0) > 0) critDevices += 1
        if ((row?.high_fail || 0) > 0) highDevices += 1
      }
    }

    // 6) Score parc : ratio global pass / (pass+fail) toutes règles, tous
    //    devices confondus. N/A exclus du dénominateur. Le KPI "Dernière
    //    éval" affichait toujours "à l'instant" (l'éval tourne à chaque
    //    checkin, et avec ~50 postes en checkin 15min, le max est toujours
    //    récent) → remplacé par ce score plus informatif.
    const scorePass  = rules.reduce((acc, r) => acc + r.pass, 0)
    const scoreFail  = rules.reduce((acc, r) => acc + r.fail, 0)
    const scoreEval  = scorePass + scoreFail
    const scorePct   = scoreEval ? Math.round(100 * scorePass / scoreEval) : null

    reply.send({
      rules,
      summary: {
        devices_total:           devicesTotal,
        devices_full_compliant:  devicesFullCompliant,
        devices_with_failures:   devicesWithFailures,
        devices_unevaluated:     devicesUnevaluated,
        critical_failing:        critDevices,
        high_failing:            highDevices,
        score_pct:               scorePct,    // null si aucune éval
        score_pass:              scorePass,
        score_eval:              scoreEval,
      },
    })
  })

  // GET /api/compliance/rules/:rule_id — drill-down devices pour une règle.
  // Retourne la liste des devices avec status (pass/fail/not_applicable),
  // hostname, user assigné. Pour agent_seen_recent, override live.
  fastify.get('/compliance/rules/:rule_id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    const ruleId = req.params.rule_id
    const rule = RULES_BY_ID.get(ruleId)
    if (!rule) return reply.code(404).send({ error: 'Règle inconnue' })

    if (ruleId === 'agent_seen_recent') {
      // Override live : on parcourt tous les devices et on calcule l'éval.
      const { rows } = await fastify.db.query(`
        SELECT d.id, d.hostname, d.source, d.last_seen, d.agent_version,
               u.display_name AS user_name
        FROM devices d
        LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
        ORDER BY d.hostname
      `)
      const devices = rows.map(r => {
        const live = evalAgentSeenRecentFromRow(r)
        return {
          device_id:  r.id,
          hostname:   r.hostname,
          user_name:  r.user_name,
          status:     live.status,
          value:      live.value || null,
          last_seen:  r.last_seen,
        }
      })
      return reply.send({
        rule: { id: rule.id, label: rule.label, severity: rule.severity },
        devices,
      })
    }

    const { rows } = await fastify.db.query(`
      SELECT d.id              AS device_id,
             d.hostname,
             d.last_seen,
             u.display_name    AS user_name,
             cr.status,
             cr.value,
             cr.evaluated_at
      FROM compliance_results cr
      JOIN devices d ON d.id = cr.device_id
      LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
      WHERE cr.rule_id = $1
      ORDER BY
        CASE cr.status WHEN 'fail' THEN 0 WHEN 'not_applicable' THEN 1 ELSE 2 END,
        d.hostname
    `, [ruleId])

    reply.send({
      rule: { id: rule.id, label: rule.label, severity: rule.severity },
      devices: rows,
    })
  })

  // GET /api/devices/:id/compliance — résultats d'un device.
  // Retourne TOUTES les règles (y compris celles 'not_applicable' implicites
  // pour ce device, ie absentes de compliance_results) avec le label/sévérité
  // depuis RULES. Override agent_seen_recent live.
  fastify.get('/devices/:id/compliance', {
    preHandler: [fastify.authenticate, fastify.requireAdmin]
  }, async (req, reply) => {
    const deviceId = req.params.id

    const { rows: devRows } = await fastify.db.query(
      `SELECT id, hostname, source, last_seen, agent_version FROM devices WHERE id = $1`,
      [deviceId]
    )
    if (!devRows.length) return reply.code(404).send({ error: 'Device introuvable' })
    const dev = devRows[0]

    const { rows: cr } = await fastify.db.query(`
      SELECT rule_id, status, severity, value, evaluated_at
      FROM compliance_results WHERE device_id = $1
    `, [deviceId])
    const crMap = new Map(cr.map(r => [r.rule_id, r]))

    const results = RULES.map(rule => {
      let row
      if (rule.id === 'agent_seen_recent') {
        const live = evalAgentSeenRecentFromRow(dev)
        row = {
          status:       live.status,
          value:        live.value || null,
          evaluated_at: new Date(),
        }
      } else {
        row = crMap.get(rule.id) || { status: 'not_applicable', value: null, evaluated_at: null }
      }
      return {
        rule_id:      rule.id,
        label:        rule.label,
        severity:     rule.severity,
        status:       row.status,
        value:        row.value,
        evaluated_at: row.evaluated_at,
      }
    })

    const counts = {
      pass:           results.filter(r => r.status === 'pass').length,
      fail:           results.filter(r => r.status === 'fail').length,
      not_applicable: results.filter(r => r.status === 'not_applicable').length,
      total:          results.length,
    }

    reply.send({
      device: { id: dev.id, hostname: dev.hostname, last_seen: dev.last_seen },
      results,
      counts,
    })
  })
}
