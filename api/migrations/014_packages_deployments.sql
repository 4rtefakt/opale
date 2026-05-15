-- Packages : applications à déployer sur les postes (winget ou script PowerShell)
CREATE TABLE IF NOT EXISTS packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL DEFAULT 'winget',   -- 'winget' | 'script'
  winget_id        TEXT,                              -- ex: 'Mozilla.Firefox'
  install_script   TEXT,                              -- PowerShell pour type='script'
  detection_script TEXT,                             -- exit 0 = installé, exit 1 = absent
  version          TEXT,                             -- version attendue (indicatif)
  status           TEXT NOT NULL DEFAULT 'draft',    -- 'draft' | 'approved'
  approved_by      TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_by       TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Déploiements : une entrée par (package × device)
CREATE TABLE IF NOT EXISTS deployments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id   UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  device_id    UUID NOT NULL REFERENCES devices(id)  ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',      -- 'pending'|'running'|'success'|'failed'|'cancelled'
  exit_code    INTEGER,
  output       TEXT,
  deployed_by  TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  queued_at    TIMESTAMPTZ DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Un seul déploiement pending par (package, device) à la fois
CREATE UNIQUE INDEX IF NOT EXISTS deployments_pending_unique
  ON deployments(package_id, device_id) WHERE status = 'pending';

-- Inventaire logiciel : résultat des scripts de détection
CREATE TABLE IF NOT EXISTS device_software (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES devices(id)  ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  detected   BOOL NOT NULL DEFAULT false,
  checked_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (device_id, package_id)
);

-- Version de l'agent sur chaque poste
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT;

-- Index
CREATE INDEX IF NOT EXISTS idx_deployments_package ON deployments(package_id);
CREATE INDEX IF NOT EXISTS idx_deployments_device  ON deployments(device_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status  ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_device_software_dev ON device_software(device_id);
