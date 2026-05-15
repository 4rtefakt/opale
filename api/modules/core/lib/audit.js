// api/lib/audit.js
//
// Helper centralisé pour insérer un événement dans audit_logs.
//
// Normalise :
//   - by_user / target / details à null si absents (vs erreur SQL)
//   - details JSON-stringifié automatiquement si c'est un objet
//     (le caller passe TOUJOURS un objet — jamais une string déjà stringifiée)
//   - non-bloquant en cas d'erreur DB (warn + continue, cohérent avec
//     le pattern dominant existant)
//
// Usage :
//   await logAudit(fastify.db, fastify.log, { action, byUser, target, details })
//   logAudit(fastify.db, fastify.log, { ... })   // fire & forget OK

export async function logAudit(db, log, { action, byUser = null, target = null, details = null }) {
  if (!action || typeof action !== 'string') {
    log?.warn?.({ action }, 'logAudit: action invalide, INSERT skip')
    return
  }
  try {
    await db.query(
      `INSERT INTO audit_logs (action, by_user, target, details)
       VALUES ($1, $2, $3, $4)`,
      [action, byUser, target, details ? JSON.stringify(details) : null]
    )
  } catch (err) {
    log?.warn?.({ err: err.message, action }, 'logAudit failed')
  }
}
