// Conversion d'un poste Windows en poste Linux géré par état désiré
// (docs/linux-fleet-design.md §3) : les faits Windows sont effacés, les
// tokens agent legacy révoqués ; l'historique (tickets, stock, groupes,
// clé par device_id) est conservé. À appeler dans la transaction d'approbation.
// Retourne le nombre de lignes supprimées / tokens révoqués par table.
export async function clearWindowsFacts(client, deviceId) {
  const counts = {}
  for (const table of ['compliance_results', 'disks', 'network_interfaces', 'device_software']) {
    const result = await client.query(`DELETE FROM ${table} WHERE device_id = $1`, [deviceId])
    counts[table] = result.rowCount
  }
  await client.query(`
    UPDATE devices SET health_signals = NULL, health_updated_at = NULL,
      system_info = NULL, ssh_host_key_fp = NULL, ssh_host_key_learned_at = NULL,
      ip_netbird = NULL, agent_version = NULL, intune_device_id = NULL,
      aad_device_id = NULL, intune_user_id = NULL, intune_user_display_name = NULL,
      intune_last_sync = NULL, compliance_state = NULL, enrolled_at = NULL, last_seen_ws = NULL
    WHERE id = $1
  `, [deviceId])
  const tokens = await client.query('UPDATE agent_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId])
  counts.agent_tokens = tokens.rowCount
  return counts
}

// Nouvelle ligne devices d'un poste Linux : marquée côté serveur
// (platform / managed_by), jamais par l'agent.
export async function createPullDevice(client, { hostname, serial, profile, ring, assignedUserId }) {
  const { rows: [device] } = await client.query(`
    INSERT INTO devices (hostname, serial, profile, ring, assigned_user_id, platform, managed_by, source)
    VALUES ($1, $2, $3, $4, $5, 'linux', 'pull', 'agent') RETURNING *
  `, [hostname, serial, profile, ring, assignedUserId ?? null])
  return device
}
