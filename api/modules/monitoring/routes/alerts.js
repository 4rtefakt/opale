// Compteur badge sidebar : alertes calculées à la volée depuis devices.
// Chaque ligne expose snoozed_until si un snooze actif existe pour le couple
// (device, type). Les snoozés sont exclus de counts.* mais restent dans la liste
// (l'UI les relègue/grise).

export default async function alertsRoute(fastify) {

  fastify.get('/', { preHandler: [fastify.authenticate, fastify.requireAdmin] }, async (req, reply) => {
    const { rows: sRows } = await fastify.db.query('SELECT key, value FROM settings')
    const s = Object.fromEntries(sRows.map(r => [r.key, r.value]))
    const diskWarn   = parseInt(s.disk_warn_pct      || '85')
    const diskCrit   = parseInt(s.disk_critical_pct  || '95')
    const offlineDays = parseInt(s.agent_offline_days || '7')

    const [crit, warn, offline, nonCompliant] = await Promise.all([

      // Disque critique
      fastify.db.query(`
        SELECT d.id, d.hostname, d.disk_used_pct, u.display_name AS user_name,
               sn.until_at AS snoozed_until
        FROM devices d
        LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
        LEFT JOIN alert_snoozes sn
               ON sn.device_id = d.id
              AND sn.alert_type = 'disk_critical'
              AND sn.until_at > now()
        WHERE d.disk_used_pct >= $1
        ORDER BY d.disk_used_pct DESC
      `, [diskCrit]),

      // Disque en avertissement
      fastify.db.query(`
        SELECT d.id, d.hostname, d.disk_used_pct, u.display_name AS user_name,
               sn.until_at AS snoozed_until
        FROM devices d
        LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
        LEFT JOIN alert_snoozes sn
               ON sn.device_id = d.id
              AND sn.alert_type = 'disk_high'
              AND sn.until_at > now()
        WHERE d.disk_used_pct >= $1 AND d.disk_used_pct < $2
        ORDER BY d.disk_used_pct DESC
      `, [diskWarn, diskCrit]),

      // Offline (agents uniquement)
      fastify.db.query(`
        SELECT d.id, d.hostname, d.last_seen, u.display_name AS user_name,
               sn.until_at AS snoozed_until
        FROM devices d
        LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
        LEFT JOIN alert_snoozes sn
               ON sn.device_id = d.id
              AND sn.alert_type = 'offline'
              AND sn.until_at > now()
        WHERE d.source = 'agent'
          AND d.last_seen < now() - make_interval(days => $1)
        ORDER BY d.last_seen ASC NULLS FIRST
      `, [offlineDays]),

      // Non-conforme Intune
      fastify.db.query(`
        SELECT d.id, d.hostname, d.compliance_state, u.display_name AS user_name,
               sn.until_at AS snoozed_until
        FROM devices d
        LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id
        LEFT JOIN alert_snoozes sn
               ON sn.device_id = d.id
              AND sn.alert_type = 'noncompliant'
              AND sn.until_at > now()
        WHERE d.compliance_state IS NOT NULL AND d.compliance_state != 'compliant'
        ORDER BY d.hostname
      `),
    ])

    // Snoozés = exclus du compteur badge mais conservés dans la liste
    const activeCount = rows => rows.filter(r => !r.snoozed_until).length

    reply.send({
      disk_critical: crit.rows,
      disk_warn:     warn.rows,
      offline:       offline.rows,
      non_compliant: nonCompliant.rows,
      counts: {
        critical: activeCount(crit.rows) + activeCount(nonCompliant.rows),
        warn:     activeCount(warn.rows) + activeCount(offline.rows),
      },
    })
  })
}
