-- Étend deployment_jobs pour cibler les groupes natifs Opale (en plus des
-- groupes Entra et du scope user/all déjà présents).

-- 1. Colonne native_group_id — référence molle ON DELETE SET NULL : si un
--    groupe natif est supprimé, le job reste mais n'envoie plus de nouveaux
--    déploiements (la colonne devient NULL et le fan-out agent ne match plus).
ALTER TABLE deployment_jobs
  ADD COLUMN IF NOT EXISTS native_group_id UUID REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_native_group
  ON deployment_jobs(native_group_id) WHERE native_group_id IS NOT NULL;

-- 2. Étendre la contrainte CHECK scope pour accepter 'native_group'.
DO $$ BEGIN
  ALTER TABLE deployment_jobs DROP CONSTRAINT IF EXISTS deployment_jobs_scope_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE deployment_jobs
  ADD CONSTRAINT deployment_jobs_scope_check
  CHECK (scope IN ('group', 'all', 'user', 'native_group'));

-- 3. Garde de cohérence sur les champs cibles.
DO $$ BEGIN
  ALTER TABLE deployment_jobs DROP CONSTRAINT IF EXISTS deployment_jobs_scope_target_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE deployment_jobs
  ADD CONSTRAINT deployment_jobs_scope_target_check
  CHECK (
    (scope = 'all'          AND source_group_id IS NULL  AND user_entra_id IS NULL  AND native_group_id IS NULL)
    OR (scope = 'group'     AND source_group_id IS NOT NULL AND user_entra_id IS NULL AND native_group_id IS NULL)
    OR (scope = 'user'      AND user_entra_id IS NOT NULL   AND source_group_id IS NULL AND native_group_id IS NULL)
    OR (scope = 'native_group' AND native_group_id IS NOT NULL AND source_group_id IS NULL AND user_entra_id IS NULL)
  );
