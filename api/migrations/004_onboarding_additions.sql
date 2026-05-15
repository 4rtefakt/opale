-- Onboardings : responsable, département, compte créé, notes
ALTER TABLE onboardings
  ADD COLUMN IF NOT EXISTS manager_name     TEXT,
  ADD COLUMN IF NOT EXISTS manager_entra_id TEXT,
  ADD COLUMN IF NOT EXISTS department       TEXT,
  ADD COLUMN IF NOT EXISTS entra_id_created TEXT,
  ADD COLUMN IF NOT EXISTS notes            TEXT,
  ADD COLUMN IF NOT EXISTS by_entra_id      TEXT,
  ADD COLUMN IF NOT EXISTS by_name          TEXT,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT now();

-- onboarding_checks : résultat automation
ALTER TABLE onboarding_checks
  ADD COLUMN IF NOT EXISTS auto_result TEXT,
  ADD COLUMN IF NOT EXISTS auto_error  TEXT,
  ADD COLUMN IF NOT EXISTS done_by     TEXT,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT now();
