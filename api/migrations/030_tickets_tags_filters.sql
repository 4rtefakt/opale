-- Tranche 1 ticketing : tags libres (palette fermée côté front) + index pour filtres avancés.
-- Strictement additif : aucun DROP, aucun ALTER de colonne existante.

CREATE TABLE IF NOT EXISTS tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT 'slate',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_tags (
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ticket_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_tags_tag      ON ticket_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned     ON tickets(assigned_to_entra_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority     ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_created_desc ON tickets(created_at DESC);
