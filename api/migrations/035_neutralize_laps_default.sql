-- Migration 035 : neutralise le DEFAULT historique de la colonne
-- device_admin_credentials.username (introduit en migration 020).
--
-- Le nom du compte recovery LAPS devient une valeur runtime configurable.
-- L'agent Go fournit toujours la valeur explicite à l'INSERT depuis
-- branding.LAPSDefaultUser (puis depuis le setting runtime). Le DEFAULT
-- n'est donc jamais consommé en pratique ; on le neutralise pour ne pas
-- léguer un branding figé aux nouvelles instances.
--
-- Idempotente : ALTER ... DROP DEFAULT n'échoue pas si déjà absent.

ALTER TABLE device_admin_credentials
  ALTER COLUMN username DROP DEFAULT;
