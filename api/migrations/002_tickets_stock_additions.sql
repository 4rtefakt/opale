-- Tickets : auteur, assignation, source
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS source               TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS created_by_entra_id  TEXT,
  ADD COLUMN IF NOT EXISTS created_by_name      TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to_entra_id TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to_name     TEXT;

-- ticket_messages : type (comment | system | resolution)
ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'comment';

-- stock_items : unité, description, seuil nommé, timestamps
ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS unit             TEXT NOT NULL DEFAULT 'pcs',
  ADD COLUMN IF NOT EXISTS description      TEXT,
  ADD COLUMN IF NOT EXISTS threshold        INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_movement_at TIMESTAMPTZ;

-- stock_movements : auteur nommé + timestamp normalisé
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS by_name    TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
