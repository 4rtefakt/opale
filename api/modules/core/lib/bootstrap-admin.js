// Attribution du tout premier compte administrateur.
//
// Sans ce mécanisme, une instance fraîchement installée n'a aucun admin
// (`users_cache.is_admin` vaut DEFAULT false) et il faut un UPDATE en psql
// pour la débloquer — ce que la documentation d'installation ne mentionnait
// pas alors qu'elle promettait une promotion automatique.
//
// Deux modes, du plus sûr au plus pratique :
//
//   1. OPALE_BOOTSTRAP_ADMIN_UPN=alice@exemple.org
//      Seul ce compte est promu, et uniquement tant qu'aucun admin n'existe.
//      À privilégier : le déployeur nomme explicitement le compte, il n'y a
//      pas de fenêtre pendant laquelle « le premier arrivé gagne ».
//
//   2. Aucune variable définie → premier-connecté (TOFU).
//      Le premier utilisateur du tenant qui se connecte devient admin. C'est
//      le comportement décrit par l'installeur, pratique mais il suppose que
//      le déployeur se connecte AVANT d'ouvrir l'accès aux autres. Un warning
//      est loggé à chaque boot tant qu'aucun admin n'existe, et la promotion
//      elle-même est tracée dans le journal d'audit.
//
// Dans les deux cas la promotion est conditionnée à « zéro admin en base » et
// sérialisée par un verrou consultatif transactionnel : deux connexions
// simultanées sur une instance neuve ne peuvent pas produire deux admins.

import { logAudit } from './audit.js'

// Même famille de clé que le runner de migrations, valeur distincte.
const BOOTSTRAP_LOCK_KEY = 4478562138

function normalizeUpn(v) {
  return String(v ?? '').trim().toLowerCase()
}

/**
 * Promeut l'identité fournie si — et seulement si — aucun admin n'existe.
 *
 * @returns {Promise<boolean>} true si une promotion a eu lieu.
 */
export async function maybeBootstrapAdmin(db, log, identity, env = process.env) {
  if (!identity?.entraId) return false

  const expectedUpn = normalizeUpn(env.OPALE_BOOTSTRAP_ADMIN_UPN)
  if (expectedUpn && normalizeUpn(identity.email) !== expectedUpn) {
    // Un compte nommé est attendu et ce n'est pas celui-ci : on ne promeut
    // personne, même s'il n'y a aucun admin.
    return false
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // Verrou transactionnel : libéré automatiquement au COMMIT/ROLLBACK.
    // Sérialise le check « zéro admin » avec l'UPDATE qui en découle.
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY])

    const { rows: existing } = await client.query(
      'SELECT 1 FROM users_cache WHERE is_admin LIMIT 1'
    )
    if (existing.length) {
      await client.query('ROLLBACK')
      return false
    }

    const { rows } = await client.query(
      `UPDATE users_cache SET is_admin = TRUE WHERE entra_id = $1
       RETURNING entra_id, display_name, email`,
      [identity.entraId]
    )
    if (!rows.length) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query('COMMIT')

    log.warn(
      { entra_id: identity.entraId, email: identity.email, mode: expectedUpn ? 'upn' : 'first-login' },
      'bootstrap : premier administrateur promu'
    )
    await logAudit(db, log, {
      action:  'admin_bootstrapped',
      byUser:  identity.displayName || identity.email || identity.entraId,
      target:  rows[0].display_name || rows[0].email || identity.entraId,
      details: { entra_id: identity.entraId, mode: expectedUpn ? 'upn' : 'first-login' },
    })
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // Non bloquant : un échec de promotion ne doit pas casser le login.
    log.error({ err: err.message }, 'bootstrap admin échoué')
    return false
  } finally {
    client.release()
  }
}

// Averti au boot tant que l'instance n'a aucun admin — un opérateur qui a
// oublié cette étape ne le découvre sinon qu'en butant sur des 403.
export async function warnIfNoAdmin(db, log, env = process.env) {
  try {
    const { rows } = await db.query('SELECT 1 FROM users_cache WHERE is_admin LIMIT 1')
    if (rows.length) return false
    log.warn(
      env.OPALE_BOOTSTRAP_ADMIN_UPN
        ? `Aucun administrateur en base. Le compte ${env.OPALE_BOOTSTRAP_ADMIN_UPN} sera promu à sa première connexion.`
        : 'Aucun administrateur en base. Le PREMIER compte qui se connectera sera promu administrateur — ' +
          'connectez-vous avant d\'ouvrir l\'accès, ou définissez OPALE_BOOTSTRAP_ADMIN_UPN.'
    )
    return true
  } catch {
    return false
  }
}
