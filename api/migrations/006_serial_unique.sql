-- Rendre le numéro de série unique pour le ON CONFLICT de la sync Intune
-- Les NULL ne se conflictent pas entre eux en PostgreSQL.
-- Idempotente : on catche `duplicate_object` (contrainte déjà nommée ainsi)
-- ET `duplicate_table` (l'index implicite existe déjà — Postgres remonte
-- ce code quand `ADD CONSTRAINT … UNIQUE` ne peut pas créer son index).
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_serial_unique UNIQUE (serial);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
END $$;
