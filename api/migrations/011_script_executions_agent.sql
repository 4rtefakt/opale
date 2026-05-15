-- Colonnes pour l'exécution via agent (mode polling)
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS mode         TEXT NOT NULL DEFAULT 'ssh',  -- 'ssh' | 'agent'
  ADD COLUMN IF NOT EXISTS queued_at    TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_code    INTEGER,
  ADD COLUMN IF NOT EXISTS script_name  TEXT,
  ADD COLUMN IF NOT EXISTS script_content TEXT;

-- Les lignes existantes sont en mode SSH
UPDATE script_executions SET mode = 'ssh' WHERE mode IS NULL OR mode = 'ssh';
