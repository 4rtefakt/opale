-- Tickets proposés : candidats générés depuis sources externes (alertes, scripts en erreur,
-- mails parsés par IA…) à valider par un admin avant de devenir des vrais tickets.
-- Table séparée : aucune pollution des requêtes existantes sur tickets.

CREATE TABLE IF NOT EXISTS ticket_proposals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Origine de la proposition
  source                 TEXT NOT NULL,            -- 'alert' | 'script' | 'email' | 'manual'
  source_ref_type        TEXT,                     -- 'alert' | 'script_execution' | 'email' | NULL
  source_ref_id          UUID,                     -- FK logique (pas FK SQL pour éviter cascades)
  source_payload         JSONB,                    -- données brutes pour traçabilité

  -- Suggestions (éditables à l'acceptation)
  suggested_title        TEXT NOT NULL,
  suggested_description  TEXT,
  suggested_priority     TEXT NOT NULL DEFAULT 'normal',
  suggested_device_id    UUID REFERENCES devices(id)             ON DELETE SET NULL,
  suggested_user_id      TEXT REFERENCES users_cache(entra_id)   ON DELETE SET NULL,

  -- Cycle de vie
  status                 TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected'
  ticket_id              UUID REFERENCES tickets(id) ON DELETE SET NULL,
  rejected_reason        TEXT,
  reviewed_by_entra_id   TEXT,
  reviewed_by_name       TEXT,
  reviewed_at            TIMESTAMPTZ,

  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_proposals_status ON ticket_proposals(status);
CREATE INDEX IF NOT EXISTS idx_ticket_proposals_source ON ticket_proposals(source, source_ref_id);
CREATE INDEX IF NOT EXISTS idx_ticket_proposals_created ON ticket_proposals(created_at DESC);
