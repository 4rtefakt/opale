-- Étend deployment_jobs.scope pour accepter 'user' (tous les PCs assignés
-- à un user Entra). Quand le user est réassigné à un nouveau PC, le job
-- redéclenche un déploiement sur ce nouveau PC au prochain checkin.

-- 1. Nouvelle colonne user_entra_id (NULL pour les jobs all|group existants)
ALTER TABLE deployment_jobs
  ADD COLUMN IF NOT EXISTS user_entra_id TEXT REFERENCES users_cache(entra_id) ON DELETE CASCADE;

-- 2. Index pour le fan-out (lookup par user au checkin)
CREATE INDEX IF NOT EXISTS idx_deployment_jobs_user
  ON deployment_jobs(user_entra_id) WHERE user_entra_id IS NOT NULL;

-- 3. Étendre la contrainte CHECK pour accepter 'user'.
-- DROP + ADD car ALTER CONSTRAINT ne supporte pas le changement de définition.
--
-- 4. Garde de cohérence : un job scope='user' DOIT avoir user_entra_id ;
--    scope='group' DOIT avoir source_group_id ; scope='all' n'a ni l'un ni
--    l'autre. Constraint exprimée comme un CHECK.
--
-- Garde de rejeu : 052 remplace ces deux contraintes par un sur-ensemble
-- (scope 'native_group' + colonne native_group_id). Si 052 est déjà passée
-- (colonne présente), rejouer 043 RÉTRÉCIRAIT les contraintes et échouerait
-- dès qu'un job native_group existe (runner de démarrage sur une base
-- migrée à la main) : on ne touche alors à rien, 052 fait foi.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'deployment_jobs'::regclass
      AND attname = 'native_group_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE deployment_jobs DROP CONSTRAINT IF EXISTS deployment_jobs_scope_check;
    ALTER TABLE deployment_jobs
      ADD CONSTRAINT deployment_jobs_scope_check
      CHECK (scope IN ('group', 'all', 'user'));

    ALTER TABLE deployment_jobs DROP CONSTRAINT IF EXISTS deployment_jobs_scope_target_check;
    ALTER TABLE deployment_jobs
      ADD CONSTRAINT deployment_jobs_scope_target_check
      CHECK (
        (scope = 'all'   AND source_group_id IS NULL AND user_entra_id IS NULL)
        OR (scope = 'group' AND source_group_id IS NOT NULL AND user_entra_id IS NULL)
        OR (scope = 'user'  AND user_entra_id IS NOT NULL AND source_group_id IS NULL)
      );
  END IF;
END $$;
