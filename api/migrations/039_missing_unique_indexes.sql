-- Migration 039 : index UNIQUE manquants depuis le commit initial.
--
-- Ces 2 index sont consommés par le code (`ON CONFLICT (...)`) mais n'avaient
-- jamais été créés via une migration — ils existaient en prod grâce à un
-- ALTER manuel post-incident, jamais propagé. Conséquence : toute nouvelle
-- instance créée from scratch via les migrations seules avait des
-- checkins agent qui plantaient en 500 (`there is no unique or exclusion
-- constraint matching the ON CONFLICT specification`).
--
-- Détecté en cours de route, formalisé ici pour les futures instances.
--
-- Idempotente : `IF NOT EXISTS`.

-- 1. disks(device_id, letter) — consommé par /api/agent/checkin pour upsert
--    les partitions d'un device.
CREATE UNIQUE INDEX IF NOT EXISTS idx_disks_device_letter
  ON disks (device_id, letter);

-- 2. devices(intune_device_id) — index partiel, consommé par la sync Intune
--    pour upsert les devices managés (clé naturelle Intune).
CREATE UNIQUE INDEX IF NOT EXISTS devices_intune_device_id_key
  ON devices (intune_device_id)
  WHERE intune_device_id IS NOT NULL;
