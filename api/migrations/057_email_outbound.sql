-- Phase 4 du pont mail ↔ tickets (issue #8) : envoi sortant.
-- Un message Opale ajouté à un ticket "venu par mail" est envoyé comme
-- réponse mail au requester, threadé correctement via In-Reply-To/References.
--
-- Stratégie : pas de hook sur les routes tickets (out of scope). Un worker
-- scanne `ticket_messages` dont `email_sent_at IS NULL`, vérifie que le
-- ticket a une origine mail (au moins un email_thread_mapping inbound),
-- envoie via Microsoft Graph, et marque `email_sent_at`.

ALTER TABLE ticket_messages
  -- NULL = pas (encore) envoyé par mail. Cette colonne sert AUSSI à
  -- bloquer la boucle infinie : les messages créés par le pipeline inbound
  -- (mail → message_appended) sont créés avec email_sent_at = now() dès
  -- l'insertion, donc l'outbox ne les renvoie pas à l'expéditeur original.
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;

-- Index pour le worker outbox : pickup rapide des messages à envoyer.
-- Partial index pour limiter la taille (la grande majorité des rows finit
-- avec email_sent_at non-NULL — interne ou envoyé).
CREATE INDEX IF NOT EXISTS idx_ticket_messages_outbox
  ON ticket_messages(created_at ASC)
  WHERE email_sent_at IS NULL AND type = 'comment';

-- Settings de l'envoi sortant.
--   sender_address       : adresse expéditrice (boîte ou alias Graph). VIDE
--                          par défaut → outbox no-op tant que pas configuré.
--   sender_display_name  : nom affiché côté destinataire (facultatif).
--   send_enabled         : kill switch.
--   send_poll_interval_s : période du worker outbox, en secondes (10s par
--                          défaut, plus court que l'inbound : on veut une
--                          réponse réactive côté maintainer).
INSERT INTO settings (key, value) VALUES
  ('mail.sender_address',       ''),
  ('mail.sender_display_name',  ''),
  ('mail.send_enabled',         'false'),
  ('mail.send_poll_interval_s', '10')
ON CONFLICT (key) DO NOTHING;
