// Nom d'hôte d'un poste Linux (docs/linux-fleet-design.md §3) :
// explicite > pré-inscription > poste existant (conversion / ré-enrôlement)
// > lx-<série normalisée> > lx-<12 premiers hex de l'empreinte>.
// Jamais le nom revendiqué par l'agent.

// Label RFC-1123 en minuscules.
export function isValidHostname(value) {
  return typeof value === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

export function resolveHostname({ explicit, preregistration, existing, serialNormalized, fingerprint }) {
  if (explicit != null) return explicit
  if (preregistration?.hostname) return preregistration.hostname
  if (existing?.hostname) return existing.hostname
  const candidate = serialNormalized ? `lx-${serialNormalized.toLowerCase()}` : null
  return isValidHostname(candidate) ? candidate : `lx-${fingerprint.slice(0, 12)}`
}

// Résout puis vérifie les noms de tout un lot avant toute transaction :
// collision avec `devices.hostname` (sauf le poste cible lui-même, qui garde
// son nom lors d'une conversion) ou entre deux lignes du lot. Sans casse :
// les postes Windows sont stockés en majuscules, les noms Linux en minuscules,
// et `PC-DUPONT` / `pc-dupont` sont le même nom sur le réseau.
// Retourne, par ligne, { hostname } ou { error: 'HOSTNAME_TAKEN', hostname }.
export async function resolveHostnamesForBatch(db, items) {
  const hostnames = items.map(resolveHostname)
  const lower = hostnames.map(h => h.toLowerCase())
  const { rows } = await db.query('SELECT id, hostname FROM devices WHERE LOWER(hostname) = ANY($1::text[])', [lower])
  return hostnames.map((hostname, i) => {
    const collision = rows.some(row => row.hostname.toLowerCase() === lower[i] && row.id !== items[i].existing?.id)
      || lower.some((other, j) => j !== i && other === lower[i])
    return collision ? { error: 'HOSTNAME_TAKEN', hostname } : { hostname }
  })
}
