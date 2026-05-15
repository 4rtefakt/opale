-- Tokens : révocation et traçabilité
ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by   TEXT;

-- Configuration clé/valeur
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT
);

INSERT INTO settings (key, value) VALUES
  ('disk_warn_pct',     '80'),
  ('disk_critical_pct', '90')
ON CONFLICT (key) DO NOTHING;
