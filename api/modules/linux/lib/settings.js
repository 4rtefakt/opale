export async function readLinuxSettings(db) {
  const { rows } = await db.query("SELECT key, value FROM settings WHERE key LIKE 'linux.%' OR key = 'agent.laps_recovery_username'")
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]))
  return {
    repo_url: values['linux.repo_url'] || null,
    allowed_signers: JSON.parse(values['linux.allowed_signers'] || '[]'),
    alerts_enabled: values['linux.alerts_enabled'] === 'true',
    rings: {
      pilot: JSON.parse(values['linux.ring.pilot'] || '{"branch":"main"}'),
      stable: JSON.parse(values['linux.ring.stable'] || '{"branch":"main"}'),
    },
    // Même défaut que /api/agent/runtime-config (agent Windows).
    local_admin_username: values['agent.laps_recovery_username'] || 'opale-recovery',
    // Stub jusqu'à la PR 5 (clé d'escrow) : l'état réel remplacera cet objet.
    escrow: { status: 'unavailable', key_id: null, bits: null, backup_confirmed: null },
  }
}

// Validation au-delà du schéma : URL https sans identifiants, nom de branche
// git valide et existant dans l'upstream quand le miroir a un contenu.
export function validateLinuxSettings(patch, mirror) {
  if (patch.repo_url !== undefined) {
    let url
    try { url = new URL(patch.repo_url) } catch { /* rejet commun ci-dessous */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password) return 'Dépôt : https uniquement en v1, sans identifiants dans l’URL'
  }
  for (const ring of ['pilot', 'stable']) {
    const branch = patch.rings?.[ring]?.branch
    if (branch !== undefined && (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || /\.\.|\/\/|@\{|\.$|\/$|\.lock(?:\/|$)|(?:^|\/)\./.test(branch))) return 'Nom de branche invalide'
    if (branch !== undefined && mirror.serving() && !Object.hasOwn(mirror.heads().upstream, branch)) return `Branche inconnue : ${branch}`
  }
  return null
}
