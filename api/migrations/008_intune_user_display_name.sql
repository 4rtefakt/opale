ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS intune_user_display_name TEXT;
