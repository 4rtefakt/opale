-- Phase 5a du pont mail ↔ tickets (issue #8) : marquage Outlook "lu" à
-- l'acceptation d'une proposition.
--
-- Stratégie : un worker scanne les `email_thread_mapping.proposal_id` dont
-- la proposition est devenue `accepted`, et appelle PATCH Graph
-- `/users/{m}/messages/{id}` avec `{isRead: true}`. On note l'horodatage
-- du marquage pour ne pas refaire l'appel.
--
-- Les `message_appended` (mail entrant matché à un ticket existant) sont
-- marqués DÈS l'ingestion par le pipeline inbound : le mail est déjà
-- visible dans Opale, plus besoin de l'avoir non-lu dans Outlook.

ALTER TABLE email_thread_mapping
  ADD COLUMN IF NOT EXISTS email_read_marked_at TIMESTAMPTZ;

-- Index pour le worker : pickup des mappings à marquer (proposal_id pointe
-- vers une proposal acceptée, mapping pas encore marqué). Partial pour
-- limiter la taille — la grande majorité finit avec un timestamp non-NULL.
CREATE INDEX IF NOT EXISTS idx_email_mapping_to_mark_read
  ON email_thread_mapping(proposal_id)
  WHERE email_read_marked_at IS NULL AND proposal_id IS NOT NULL;

INSERT INTO settings (key, value) VALUES
  -- Active le marquage Outlook (nécessite perm Graph Mail.ReadWrite).
  -- false par défaut : sans la perm, le PATCH échouera silencieusement.
  ('mail.mark_as_read_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
