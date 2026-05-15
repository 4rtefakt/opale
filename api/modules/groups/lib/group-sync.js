import { getGroupDeviceHostnames } from '../../core/lib/graph.js'

// Interval de sync par défaut : 60 minutes
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000
let _timer = null

// Résout les hostnames d'un groupe Entra en device_ids managés.
// Matching primaire par hostname (UNIQUE dans devices), avec blocklist
// des serials génériques — le matching serial sera ajouté ici si on
// internalise les groupes.
async function resolveGroupToDeviceIds(db, groupId) {
  let hostnames
  try {
    hostnames = await getGroupDeviceHostnames(groupId)
  } catch (err) {
    throw new Error(`Graph: ${err.message}`)
  }
  if (!hostnames.length) return []
  const { rows } = await db.query(
    `SELECT id FROM devices WHERE hostname = ANY($1::text[])`, [hostnames]
  )
  return rows.map(r => r.id)
}

// Sync complète : itère sur tous les deployment_jobs group actifs,
// full-replace les memberships par groupe dans une transaction.
export async function syncGroupMemberships(db, log) {
  const { rows: jobs } = await db.query(`
    SELECT DISTINCT source_group_id
    FROM deployment_jobs
    WHERE status = 'active' AND scope = 'group' AND source_group_id IS NOT NULL
  `)

  if (!jobs.length) return { groups: 0, devices_matched: 0, devices_unmatched: 0 }

  let devicesMatched = 0
  let devicesUnmatched = 0

  for (const { source_group_id: groupId } of jobs) {
    let deviceIds
    try {
      deviceIds = await resolveGroupToDeviceIds(db, groupId)
    } catch (err) {
      log?.warn({ err: err.message, groupId }, 'group-sync: résolution échouée, groupe ignoré')
      continue
    }

    // Full-replace atomique pour ce groupe
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM device_group_memberships WHERE group_id = $1`, [groupId])
      for (const deviceId of deviceIds) {
        await client.query(
          `INSERT INTO device_group_memberships (device_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [deviceId, groupId]
        )
      }
      await client.query('COMMIT')
      devicesMatched += deviceIds.length
    } catch (err) {
      await client.query('ROLLBACK')
      log?.warn({ err: err.message, groupId }, 'group-sync: rollback')
    } finally {
      client.release()
    }
  }

  const result = { groups: jobs.length, devices_matched: devicesMatched, devices_unmatched: devicesUnmatched }
  log?.info(result, 'group-sync: terminé')
  return result
}

// Démarre le worker périodique. Appelé au démarrage de l'API.
// intervalMs peut être surchargé pour les tests.
export function startGroupSyncWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return  // idempotent

  const run = () => syncGroupMemberships(db, log).catch(err => log?.warn({ err: err.message }, 'group-sync: erreur worker'))

  run()  // premier run immédiat
  _timer = setInterval(run, intervalMs)
  log?.info({ intervalMs }, 'group-sync: worker démarré')
}

export function stopGroupSyncWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
}
