-- Deployment scope : groupes Entra ou global
-- Un deployment_job = template (scope group|all)
-- Les deployments existants restent valides (job_id NULL = déploiement direct 1-par-1)

CREATE TABLE IF NOT EXISTS deployment_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('group', 'all')),
  source_group_id TEXT,                   -- Entra group object ID (scope=group seulement)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  deployed_by     TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_status    ON deployment_jobs(status);
CREATE INDEX IF NOT EXISTS idx_deployment_jobs_package   ON deployment_jobs(package_id);

-- Cache des appartenances de groupes Entra pour les devices managés
-- Full-replace par groupe lors de chaque sync
CREATE TABLE IF NOT EXISTS device_group_memberships (
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL,               -- Entra group object ID
  synced_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (device_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_device_group_memberships_group ON device_group_memberships(group_id);

-- Lien optionnel entre une exécution et le job qui l'a générée
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES deployment_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_deployments_job ON deployments(job_id);
