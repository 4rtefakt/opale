-- Source d'enrôlement du device : intune | agent | manual
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'intune';

-- Mettre à jour les devices existants qui ont un intune_device_id.
-- `AND source IS NULL` : au premier passage, l'ADD COLUMN … DEFAULT 'intune'
-- a déjà rempli toutes les lignes (UPDATE sans effet) ; au rejeu (runner de
-- démarrage sur une base migrée à la main), on ne rebascule PAS en 'intune'
-- un poste enrôlé par l'agent puis rapproché par la sync Intune — il
-- sortirait des alertes « offline » (filtre source='agent').
UPDATE devices SET source = 'intune' WHERE intune_device_id IS NOT NULL AND source IS NULL;

-- Colonne updated_at pour tracer les checkins agent
ALTER TABLE devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Upsert disks : updated_at pour savoir si la donnée est fraîche
ALTER TABLE disks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
