// Règles de rattachement d'un NOUVEAU token agent à un device DÉJÀ présent
// en base (enrôlement). Partagées par :
//   - POST /api/agent/exchange-token (bootstrap → token perso), quand le
//     hostname existe déjà (cas normal : device pré-créé par la sync Intune) ;
//   - POST /api/agent/checkin avec un token non lié (token créé dans
//     Paramètres → Tokens pour install.ps1), quand le poste existe déjà.
//
// Un device existant ne peut être revendiqué que si :
//   1. son numéro de série (s'il en a un réel) correspond à celui envoyé
//      (comparaison normalisée : trim + insensible à la casse ; les séries
//      bidon type « To be filled by O.E.M. » comptent comme absentes) ;
//   2. aucun token agent actif de ce device n'a déjà servi (last_used_at
//      renseigné = un agent a déjà fait au moins un checkin avec). Un token
//      émis mais jamais utilisé (install précédente interrompue avant le 1er
//      checkin) ne bloque pas : sinon les relances Intune d'une install
//      ratée échoueraient toutes.
// Sinon refus : un bootstrap (ou un token non lié) fuité ne permet plus
// d'usurper un poste déjà enrôlé. Un PC réinstallé dont l'ancien token est
// encore actif est refusé jusqu'à ce qu'un admin révoque ce token.

// Même liste que la sync Intune (core/routes/settings.js) : valeurs SMBIOS
// génériques qui n'identifient pas une machine.
const FAKE_SERIALS = new Set([
  'unknown', 'systemserialnumber', 'system serial number',
  'to be filled by o.e.m.', 'to be filled', 'none', 'n/a', 'default string', '0',
])

// Série normalisée pour comparaison, ou null si absente / bidon.
export function normalizeSerial(serial) {
  if (serial === null || serial === undefined) return null
  const v = String(serial).trim()
  if (!v || FAKE_SERIALS.has(v.toLowerCase())) return null
  return v.toUpperCase()
}

// Retourne null si le device peut être revendiqué, sinon
// { reason: 'serial_missing' | 'serial_mismatch' | 'active_token', token_id? }.
// `device` = { id, serial } ; `serial` = série envoyée par le poste.
// `excludeTokenId` : token en cours de rattachement, ignoré dans le check 2.
export async function checkDeviceClaim(db, { device, serial, excludeTokenId = null }) {
  const deviceSerial = normalizeSerial(device.serial)
  if (deviceSerial) {
    const sent = normalizeSerial(serial)
    if (!sent) return { reason: 'serial_missing' }
    if (sent !== deviceSerial) return { reason: 'serial_mismatch' }
  }

  const { rows } = await db.query(`
    SELECT id FROM agent_tokens
    WHERE device_id = $1
      AND is_bootstrap = FALSE
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND last_used_at IS NOT NULL
      AND ($2::uuid IS NULL OR id <> $2::uuid)
    LIMIT 1
  `, [device.id, excludeTokenId])
  if (rows.length) return { reason: 'active_token', token_id: rows[0].id }

  return null
}

// Messages renvoyés au poste (loggés par l'installeur) — volontairement
// actionnables pour l'admin qui lira le log.
export const CLAIM_REFUSAL_MESSAGES = {
  serial_missing:  'Poste déjà connu avec un numéro de série : série absente de la requête — enrôlement refusé',
  serial_mismatch: 'Poste déjà connu avec un autre numéro de série — enrôlement refusé',
  active_token:    'Poste déjà enrôlé (token actif) — un admin doit révoquer l\'ancien token avant réenrôlement',
}
