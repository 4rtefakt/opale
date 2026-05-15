-- Tokens CLI longue durée pour l'outil `opale`.
-- Pattern identique aux agent_tokens mais lié à un utilisateur Entra
-- plutôt qu'à un device. Émis via POST /api/auth/cli-token après
-- vérification d'un JWT Entra valide ; révocables depuis l'UI Paramètres.
CREATE TABLE IF NOT EXISTS cli_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  entra_id     TEXT NOT NULL REFERENCES users_cache(entra_id) ON DELETE CASCADE,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_token_hash ON cli_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_entra_id   ON cli_tokens (entra_id);
