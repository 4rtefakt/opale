-- Clés SSH publiques — remplace le champ settings.ssh_public_key (scalaire)
CREATE TABLE IF NOT EXISTS ssh_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);
