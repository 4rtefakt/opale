-- Migration 073 : contraintes d'énumération sur tickets.status et
-- tickets.priority.
--
-- Ces deux colonnes étaient des TEXT libres depuis 001_init, et
-- PATCH /api/tickets/:id y écrivait la valeur du body sans la valider. Un
-- statut arbitraire passait donc en base et cassait silencieusement le
-- regroupement Kanban et les filtres de liste — sans erreur nulle part. Les
-- tables plus récentes (041, 048) ont déjà ce genre de CHECK ; on aligne.
--
-- La validation applicative est posée dans routes/tickets.js ; cette
-- contrainte est la ceinture : elle couvre aussi les scripts de maintenance,
-- les workers et un psql direct.
--
-- NOT VALID est délibéré :
--   • les nouvelles lignes et toute mise à jour sont vérifiées ;
--   • les lignes existantes ne sont PAS scannées, donc pas de ACCESS
--     EXCLUSIVE prolongé sur une table de production, et une instance qui
--     aurait déjà des valeurs aberrantes migre sans échouer.
-- Pour les valider a posteriori une fois les données nettoyées :
--   ALTER TABLE tickets VALIDATE CONSTRAINT tickets_status_check;
--
-- Idempotente : bloc DO qui ignore duplicate_object.

DO $$ BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'merged')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'critical')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
