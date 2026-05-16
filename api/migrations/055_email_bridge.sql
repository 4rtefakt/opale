-- Phase 1 du pont mail ↔ Tickets (issue #8) : infra de lecture seulement.
-- Aucune création de ticket ici : le worker se contente de logguer les mails
-- entrants. La table email_thread_mapping est introduite dès maintenant pour
-- la dédup (internet_message_id UNIQUE) et pour servir de socle aux phases
-- 3 (création ticket) et 4 (envoi sortant + threading).

CREATE TABLE IF NOT EXISTS email_thread_mapping (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identifiants Graph / RFC 5322
  internet_message_id    TEXT NOT NULL UNIQUE,   -- "<abc@...>" : clé de dédup et de threading
  conversation_id        TEXT,                   -- conversationId Graph (Outlook thread)
  graph_message_id       TEXT,                   -- id interne Graph pour re-fetch ciblé

  -- Contexte de réception
  mailbox                TEXT NOT NULL,          -- adresse de la boîte source (multi-mailbox supporté)
  direction              TEXT NOT NULL,          -- 'inbound' | 'outbound'
  from_address           TEXT,
  subject                TEXT,
  received_at            TIMESTAMPTZ,

  -- Lien ticket (vide en Phase 1, rempli en Phase 3)
  ticket_id              UUID REFERENCES tickets(id) ON DELETE SET NULL,

  -- Brut Graph complet : utile pour rejouer la classif Phase 2 sans re-fetch.
  raw                    JSONB,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Polling : on lit par mailbox, ordonné par receivedDateTime ; un index sur
-- (mailbox, received_at) couvre les requêtes "messages récents pour debug"
-- et le calcul du curseur "max(received_at) par mailbox".
CREATE INDEX IF NOT EXISTS idx_email_mapping_mailbox_received
  ON email_thread_mapping(mailbox, received_at DESC);

-- Le matching Phase 4 lookera par conversation_id en complément du parsing
-- In-Reply-To/References.
CREATE INDEX IF NOT EXISTS idx_email_mapping_conversation
  ON email_thread_mapping(conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_mapping_ticket
  ON email_thread_mapping(ticket_id)
  WHERE ticket_id IS NOT NULL;

-- Settings du pont. Clés convention `mail.*`. Le worker no-op tant que
-- `mail.inboxes` est vide → on peut déployer sans configurer.
INSERT INTO settings (key, value) VALUES
  ('mail.inboxes',       ''),
  ('mail.poll_enabled',  'false')
ON CONFLICT (key) DO NOTHING;
