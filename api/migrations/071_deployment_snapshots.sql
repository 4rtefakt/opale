-- 071 : snapshot du contenu d'un package pour chaque déploiement.
--
-- Avant : le checkin agent envoyait le contenu COURANT de `packages`
-- (scripts install / post-install / détection) au moment où le poste
-- récupérait son déploiement. Toute modification du package entre la
-- mise en file et le checkin partait telle quelle en SYSTEM.
--
-- Désormais le contenu est figé dans `deployment_snapshots` :
--   - à la mise en file (POST /api/packages/:id/deploy, fan-out des
--     deployment_jobs au checkin), uniquement si le package est approuvé ;
--   - rafraîchi pour les déploiements encore 'pending' quand un admin
--     (ré-)approuve le package ;
--   - rafraîchi au retry d'un déploiement failed/cancelled (package
--     approuvé exigé).
-- Le checkin ne distribue que des déploiements 'pending' de packages
-- approuvés ET ayant un snapshot ; il envoie le contenu du snapshot.
--
-- Table 1:1 séparée plutôt que colonnes sur `deployments` : les listes
-- (GET /api/deployments, GET /api/packages/:id) font `SELECT d.*` sur
-- jusqu'à 300 lignes — on n'y embarque pas les scripts.

CREATE TABLE IF NOT EXISTS deployment_snapshots (
  deployment_id        UUID PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL,
  winget_id            TEXT,
  install_script       TEXT,
  post_install_script  TEXT,
  detection_script     TEXT,
  -- Traçabilité : quelle approbation a produit ce contenu.
  package_approved_by  TEXT,
  package_approved_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill : déploiements encore 'pending' de packages approuvés.
-- Idempotent (ON CONFLICT DO NOTHING) — peut être rejoué sans effet, et
-- DOIT être rejoué une fois après le redémarrage de l'API si des
-- déploiements ont été créés par l'ancien code entre l'application de
-- cette migration et le déploiement du nouveau code.
-- Les 'pending' de packages en draft ne reçoivent pas de snapshot ici :
-- ils en recevront un à la ré-approbation du package.
INSERT INTO deployment_snapshots (
  deployment_id, name, type, winget_id,
  install_script, post_install_script, detection_script,
  package_approved_by, package_approved_at
)
SELECT d.id, p.name, p.type, p.winget_id,
       p.install_script, p.post_install_script, p.detection_script,
       p.approved_by, p.approved_at
FROM deployments d
JOIN packages p ON p.id = d.package_id
WHERE d.status = 'pending' AND p.status = 'approved'
ON CONFLICT (deployment_id) DO NOTHING;
