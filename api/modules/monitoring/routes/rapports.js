// Rapports — vue agrégée du parc et de l'activité opérationnelle.
// Aucun chiffre temps réel ici : c'est le rôle du Dashboard.

export default async function rapportsRoute(fastify) {
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {

    // Settings : taux horaire direct (défaut 32500 / 1442 ≈ 22.54 €/h).
    const settingsRow = await fastify.db.query(
      `SELECT value FROM settings WHERE key = 'cost_per_hour'`
    )
    const hourlyRate = parseFloat(settingsRow.rows[0]?.value ?? '22.54')

    const [
      kpiParc,
      complianceRows,
      activityRows,
      ticketsByTagWeekly,
      diskTop,
      batteryStats,
      activeDevicesCount,
    ] = await Promise.all([

      // ── KPI Parc supervisé : postes vus < 7 jours / total ──
      fastify.db.query(`
        SELECT
          COUNT(*)                                                    AS total,
          COUNT(*) FILTER (WHERE last_seen > now() - interval '7 days') AS active_7d
        FROM devices
      `),

      // ── Conformité sécurité : 6 critères depuis health_signals JSONB ──
      // Pour chaque critère : ok / ko / na (non remonté).
      // Postes "non remonté" = health_signals NULL ou clé absente.
      fastify.db.query(`
        WITH base AS (SELECT id, health_signals AS h FROM devices)
        SELECT
          -- Bitlocker
          COUNT(*) FILTER (WHERE (h->'bitlocker'->>'enabled')::bool = true)  AS bitlocker_ok,
          COUNT(*) FILTER (WHERE (h->'bitlocker'->>'enabled')::bool = false) AS bitlocker_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'bitlocker' IS NULL)        AS bitlocker_na,

          -- Defender à jour (signature < 3j)
          COUNT(*) FILTER (WHERE (h->'defender'->>'antivirus_enabled')::bool = true
                            AND (h->'defender'->>'signature_age_days')::int < 3) AS defender_ok,
          COUNT(*) FILTER (WHERE h->'defender' IS NOT NULL
                            AND ((h->'defender'->>'antivirus_enabled')::bool = false
                                 OR (h->'defender'->>'signature_age_days')::int >= 3)) AS defender_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'defender' IS NULL)         AS defender_na,

          -- Firewall (3 profils actifs)
          COUNT(*) FILTER (WHERE (h->'firewall'->>'domain_enabled')::bool  = true
                            AND (h->'firewall'->>'private_enabled')::bool = true
                            AND (h->'firewall'->>'public_enabled')::bool  = true) AS firewall_ok,
          COUNT(*) FILTER (WHERE h->'firewall' IS NOT NULL
                            AND ((h->'firewall'->>'domain_enabled')::bool  = false
                                 OR (h->'firewall'->>'private_enabled')::bool = false
                                 OR (h->'firewall'->>'public_enabled')::bool  = false)) AS firewall_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'firewall' IS NULL)        AS firewall_na,

          -- TPM présent
          COUNT(*) FILTER (WHERE (h->>'tpm_present')::bool = true)  AS tpm_ok,
          COUNT(*) FILTER (WHERE (h->>'tpm_present')::bool = false) AS tpm_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'tpm_present' IS NULL) AS tpm_na,

          -- Pas de redémarrage en attente
          COUNT(*) FILTER (WHERE (h->>'pending_reboot')::bool = false) AS reboot_ok,
          COUNT(*) FILTER (WHERE (h->>'pending_reboot')::bool = true)  AS reboot_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'pending_reboot' IS NULL) AS reboot_na,

          -- Windows Update récent (< 30j)
          COUNT(*) FILTER (WHERE (h->>'last_windows_update')::timestamptz > now() - interval '30 days') AS update_ok,
          COUNT(*) FILTER (WHERE h->'last_windows_update' IS NOT NULL
                            AND (h->>'last_windows_update')::timestamptz <= now() - interval '30 days') AS update_ko,
          COUNT(*) FILTER (WHERE h IS NULL OR h->'last_windows_update' IS NULL) AS update_na
        FROM base
      `),

      // ── Activité 30j : audit_logs joints à automation_costs ──
      // On exclut explicitement les actions techniques (agent_checkin, setup_script, etc.)
      // qui n'ont pas de mapping dans automation_costs.
      fastify.db.query(`
        SELECT
          al.action,
          ac.label,
          ac.estimated_minutes,
          COUNT(*) AS count
        FROM audit_logs al
        INNER JOIN automation_costs ac ON ac.action_type = al.action
        WHERE al.created_at > now() - interval '30 days'
        GROUP BY al.action, ac.label, ac.estimated_minutes
        ORDER BY (COUNT(*) * ac.estimated_minutes) DESC
      `),

      // ── Tickets par tag, 12 semaines ──
      // Bucketing ISO sur DATE_TRUNC('week', created_at).
      fastify.db.query(`
        WITH weeks AS (
          SELECT generate_series(
            DATE_TRUNC('week', now() - interval '11 weeks'),
            DATE_TRUNC('week', now()),
            interval '1 week'
          ) AS week_start
        ),
        ticket_weeks AS (
          SELECT t.id, DATE_TRUNC('week', t.created_at) AS week_start
          FROM tickets t
          WHERE t.created_at >= DATE_TRUNC('week', now() - interval '11 weeks')
        ),
        tt AS (
          SELECT tw.week_start, COALESCE(g.name, '__none__') AS tag_name, COALESCE(g.color, 'slate') AS tag_color
          FROM ticket_weeks tw
          LEFT JOIN ticket_tags tta ON tta.ticket_id = tw.id
          LEFT JOIN tags g          ON g.id = tta.tag_id
        )
        SELECT
          to_char(w.week_start, 'IYYY-"W"IW') AS week_label,
          tt.tag_name,
          tt.tag_color,
          COUNT(tt.tag_name) AS count
        FROM weeks w
        LEFT JOIN tt ON tt.week_start = w.week_start
        GROUP BY w.week_start, tt.tag_name, tt.tag_color
        ORDER BY w.week_start, tt.tag_name
      `),

      // ── Top 5 postes au disque le plus rempli (parmi ceux vus < 7j) ──
      fastify.db.query(`
        SELECT id, hostname, disk_used_pct
        FROM devices
        WHERE disk_used_pct IS NOT NULL
          AND last_seen > now() - interval '7 days'
        ORDER BY disk_used_pct DESC
        LIMIT 5
      `),

      // ── Santé batterie : 3 tranches depuis system_info->'battery_health'->'health_pct' ──
      fastify.db.query(`
        WITH b AS (
          SELECT (system_info->'battery_health'->>'health_pct')::float AS pct
          FROM devices
          WHERE system_info->'battery_health'->>'health_pct' IS NOT NULL
        )
        SELECT
          COUNT(*) FILTER (WHERE pct >= 80)              AS good,
          COUNT(*) FILTER (WHERE pct >= 50 AND pct < 80) AS degraded,
          COUNT(*) FILTER (WHERE pct < 50)               AS critical,
          COUNT(*)                                       AS total
        FROM b
      `),

      // ── Postes actifs sur 30j (pour calculer l'inventaire mensuel) ──
      fastify.db.query(`
        SELECT COUNT(*) AS n
        FROM devices
        WHERE last_seen > now() - interval '30 days'
      `),

    ])

    // ── Construction de l'activity breakdown ──
    // Pour les actions tracées dans audit_logs : count direct.
    // Pour `agent_checkin_summary` (pas tracé) : 1 inventaire / mois / poste actif.
    const ac_lookup = await fastify.db.query(
      `SELECT action_type, label, estimated_minutes FROM automation_costs`
    )
    const acMap = Object.fromEntries(ac_lookup.rows.map(r => [r.action_type, r]))

    const activity = activityRows.rows.map(r => ({
      action_type:       r.action,
      label:             r.label,
      count:             parseInt(r.count),
      estimated_minutes: parseInt(r.estimated_minutes),
      total_minutes:     parseInt(r.count) * parseInt(r.estimated_minutes),
      total_eur:         Math.round(parseInt(r.count) * parseInt(r.estimated_minutes) * hourlyRate / 60),
    }))

    // Ajout synthétique : agent_checkin_summary (1 par poste actif sur 30j)
    const checkinAc = acMap['agent_checkin_summary']
    if (checkinAc) {
      const n = parseInt(activeDevicesCount.rows[0].n)
      if (n > 0) {
        const mins = parseInt(checkinAc.estimated_minutes)
        activity.unshift({
          action_type:       'agent_checkin_summary',
          label:             checkinAc.label,
          count:             n,
          estimated_minutes: mins,
          total_minutes:     n * mins,
          total_eur:         Math.round(n * mins * hourlyRate / 60),
        })
      }
    }

    const totalMinutes = activity.reduce((s, r) => s + r.total_minutes, 0)
    const totalEur     = Math.round(totalMinutes * hourlyRate / 60)
    const totalCount   = activity.reduce((s, r) => s + r.count, 0)

    // ── Compliance : transformation des colonnes plates en structure ──
    const c = complianceRows.rows[0]
    const compliance = [
      { key: 'bitlocker', ok: parseInt(c.bitlocker_ok), ko: parseInt(c.bitlocker_ko), na: parseInt(c.bitlocker_na) },
      { key: 'defender',  ok: parseInt(c.defender_ok),  ko: parseInt(c.defender_ko),  na: parseInt(c.defender_na)  },
      { key: 'firewall',  ok: parseInt(c.firewall_ok),  ko: parseInt(c.firewall_ko),  na: parseInt(c.firewall_na)  },
      { key: 'tpm',       ok: parseInt(c.tpm_ok),       ko: parseInt(c.tpm_ko),       na: parseInt(c.tpm_na)       },
      { key: 'reboot',    ok: parseInt(c.reboot_ok),    ko: parseInt(c.reboot_ko),    na: parseInt(c.reboot_na)    },
      { key: 'update',    ok: parseInt(c.update_ok),    ko: parseInt(c.update_ko),    na: parseInt(c.update_na)    },
    ]

    // Score sécurité = moyenne des % conformes (en excluant les "non remonté" du dénominateur).
    // Si tous les postes sont "na" pour un critère, il est ignoré dans la moyenne.
    let scoreSum = 0, scoreCount = 0
    for (const c of compliance) {
      const denom = c.ok + c.ko
      if (denom > 0) { scoreSum += c.ok / denom; scoreCount++ }
    }
    const securityScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) : null

    // ── Pivot tickets par tag par semaine ──
    // Renvoie : weeks (array de labels) + datasets ({ tag_name, color, data: [count par semaine] })
    const weeksSet = new Set()
    const tagsMap  = new Map()  // tag_name → { color, data: Map<week, count> }
    for (const r of ticketsByTagWeekly.rows) {
      weeksSet.add(r.week_label)
      if (!r.tag_name) continue  // ignore les semaines sans aucun ticket
      const name  = r.tag_name === '__none__' ? null : r.tag_name
      const color = r.tag_color || 'slate'
      const k     = name ?? '__none__'
      if (!tagsMap.has(k)) tagsMap.set(k, { name, color, data: new Map() })
      tagsMap.get(k).data.set(r.week_label, parseInt(r.count))
    }
    const weeks = Array.from(weeksSet).sort()
    const ticketsByTag = Array.from(tagsMap.values()).map(t => ({
      name:  t.name,            // null si "Sans tag"
      color: t.color,
      data:  weeks.map(w => t.data.get(w) ?? 0),
    }))
    // Tri : "Sans tag" en dernier, sinon volume décroissant
    ticketsByTag.sort((a, b) => {
      if (a.name === null) return 1
      if (b.name === null) return -1
      const sa = a.data.reduce((s, v) => s + v, 0)
      const sb = b.data.reduce((s, v) => s + v, 0)
      return sb - sa
    })

    const k = kpiParc.rows[0]
    const b = batteryStats.rows[0]

    reply.send({
      kpis: {
        parc: {
          total:     parseInt(k.total),
          active_7d: parseInt(k.active_7d),
        },
        security_score: securityScore,
        actions_count:  totalCount,
        time_saved: {
          minutes:     totalMinutes,
          eur:         totalEur,
          hourly_rate: parseFloat(hourlyRate.toFixed(2)),
          annual_eur:  Math.round(totalEur * 12),  // projection sur 1 an
        },
      },
      compliance,
      activity,
      tickets_by_tag: { weeks, datasets: ticketsByTag },
      disk_top:       diskTop.rows,
      battery: {
        good:     parseInt(b.good     ?? 0),
        degraded: parseInt(b.degraded ?? 0),
        critical: parseInt(b.critical ?? 0),
        total:    parseInt(b.total    ?? 0),
      },
    })
  })
}
