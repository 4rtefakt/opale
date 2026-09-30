-- Racine chiffrée (LUKS) déclarée par l'agent au dernier check-in : porté par
-- la clé (comme agent_version / os_version), sert au filtre « non escrowé ».
-- Rejeu sûr : colonne nullable, aucun backfill.

ALTER TABLE linux_device_keys ADD COLUMN IF NOT EXISTS luks_root BOOLEAN;
