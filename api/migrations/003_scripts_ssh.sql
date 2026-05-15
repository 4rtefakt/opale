-- scripts : auteur, type shell, timestamp modif
ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS by_entra_id TEXT,
  ADD COLUMN IF NOT EXISTS by_name     TEXT,
  ADD COLUMN IF NOT EXISTS shell_type  TEXT NOT NULL DEFAULT 'powershell',
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT now();

-- script_executions : auteur nommé
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS by_name TEXT;

-- Sessions SSH (journal d'accès)
CREATE TABLE IF NOT EXISTS ssh_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID REFERENCES devices(id) ON DELETE CASCADE,
  by_entra_id TEXT,
  by_name     TEXT,
  ip          TEXT,
  started_at  TIMESTAMPTZ DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
