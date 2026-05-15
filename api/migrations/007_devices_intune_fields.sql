-- Nouvelles colonnes pour les données enrichies depuis Intune
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS intune_device_id  TEXT,
  ADD COLUMN IF NOT EXISTS aad_device_id     TEXT,
  ADD COLUMN IF NOT EXISTS intune_user_id    TEXT,
  ADD COLUMN IF NOT EXISTS compliance_state  TEXT,
  ADD COLUMN IF NOT EXISTS intune_last_sync  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS join_type         TEXT,
  ADD COLUMN IF NOT EXISTS enrolled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disk_total_gb     NUMERIC;
