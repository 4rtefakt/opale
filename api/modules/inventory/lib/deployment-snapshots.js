// Snapshot du contenu d'un package dans `deployment_snapshots` (cf. migration
// 071). Ce qui part en SYSTEM sur un poste est le contenu figé ici, jamais
// le contenu courant de `packages`.
//
// Fragments SQL constants (aucune donnée utilisateur interpolée) partagés
// par les points de création / re-mise en file d'un déploiement :
//   - POST /api/packages/:id/deploy          (routes/packages.js)
//   - POST /api/packages/:id/approve         (rafraîchit les 'pending')
//   - fan-out deployment_jobs au checkin     (routes/agent.js)
//   - retry / retry-bulk                     (routes/deployments.js)
//
// Règle commune : le snapshot n'est écrit que si le package est approuvé
// au moment de l'écriture (filtre `p.status = 'approved'` dans la même
// requête que la lecture du contenu → pas de TOCTOU).

export const SNAPSHOT_COLUMNS = `
  deployment_id, name, type, winget_id,
  install_script, post_install_script, detection_script,
  package_approved_by, package_approved_at`

// Liste SELECT correspondant à SNAPSHOT_COLUMNS. `dep` = alias portant
// l'id du déploiement, `pkg` = alias de la table packages.
export function snapshotSelect(dep, pkg) {
  return `
  ${dep}.id, ${pkg}.name, ${pkg}.type, ${pkg}.winget_id,
  ${pkg}.install_script, ${pkg}.post_install_script, ${pkg}.detection_script,
  ${pkg}.approved_by, ${pkg}.approved_at`
}

// Un déploiement re-mis en file (retry, ré-approbation) reprend le contenu
// approuvé courant.
export const SNAPSHOT_UPSERT = `
  ON CONFLICT (deployment_id) DO UPDATE SET
    name                = EXCLUDED.name,
    type                = EXCLUDED.type,
    winget_id           = EXCLUDED.winget_id,
    install_script      = EXCLUDED.install_script,
    post_install_script = EXCLUDED.post_install_script,
    detection_script    = EXCLUDED.detection_script,
    package_approved_by = EXCLUDED.package_approved_by,
    package_approved_at = EXCLUDED.package_approved_at,
    created_at          = now()`
