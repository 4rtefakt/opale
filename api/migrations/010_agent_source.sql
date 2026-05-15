-- Source d'enrôlement du device : intune | agent | manual
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'intune';

-- Mettre à jour les devices existants qui ont un intune_device_id
UPDATE devices SET source = 'intune' WHERE intune_device_id IS NOT NULL;

-- Colonne updated_at pour tracer les checkins agent
ALTER TABLE devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Upsert disks : updated_at pour savoir si la donnée est fraîche
ALTER TABLE disks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
