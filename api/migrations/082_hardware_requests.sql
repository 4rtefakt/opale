-- Module hardware : suivi des demandes de matériel et des commandes (postes,
-- accessoires, pièces, factures fournisseurs…), à part des tickets. Une
-- demande peut pointer vers le ticket d'origine, mais vit sans lui.
-- Rejeu sûr : CREATE … IF NOT EXISTS uniquement, aucun backfill.

CREATE TABLE IF NOT EXISTS hardware_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL,
  category            TEXT,
  -- Statuts : liste fermée, dupliquée dans modules/hardware/lib/statuses.js.
  status              TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'quote', 'awaiting_choice', 'approval', 'to_order',
                                        'ordered', 'received', 'to_prepare', 'to_install',
                                        'diagnosis', 'to_test', 'done', 'cancelled')),
  priority            TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low', 'normal', 'high')),
  -- Demandeur : un utilisateur de l'annuaire, ou un libellé libre (fournisseur,
  -- personne pas encore arrivée, plusieurs personnes).
  requester_entra_id  TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  requester_label     TEXT,
  ticket_id           UUID REFERENCES tickets(id) ON DELETE SET NULL,
  requested_at        DATE,
  planned_for         DATE,
  next_action         TEXT,
  -- Relances reçues du demandeur (compteur + date de la dernière).
  reminder_count      INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  last_reminder_at    DATE,
  -- Commande.
  supplier            TEXT,
  order_ref           TEXT,
  amount_eur          NUMERIC(10, 2) CHECK (amount_eur IS NULL OR amount_eur >= 0),
  budget_code         TEXT,
  ordered_at          DATE,
  received_at         DATE,
  notes               TEXT,
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hardware_requests_status
  ON hardware_requests(status);
CREATE INDEX IF NOT EXISTS idx_hardware_requests_ticket
  ON hardware_requests(ticket_id) WHERE ticket_id IS NOT NULL;

-- Historique d'une demande : création, changements de statut, relances, notes.
CREATE TABLE IF NOT EXISTS hardware_request_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID NOT NULL REFERENCES hardware_requests(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('created', 'status', 'reminder', 'note')),
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  by_name      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hardware_request_events_request
  ON hardware_request_events(request_id, created_at DESC);
