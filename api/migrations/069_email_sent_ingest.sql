-- Ingestion des mails ENVOYÉS hors Opale (issue #8, extension du pont mail).
--
-- Problème : quand un agent répond à un fil de ticket depuis sa propre boîte
-- Outlook au lieu de cliquer "Répondre" dans Opale, sa réponse n'apparaît
-- jamais dans la conversation du ticket. On scanne donc le dossier "Éléments
-- envoyés" des boîtes configurées et — UNIQUEMENT si le mail est threadé à un
-- ticket EXISTANT (In-Reply-To / References / conversationId) — on append la
-- réponse au ticket comme un message 'comment' déjà envoyé (email_sent_at posé
-- pour que l'outbox ne le renvoie pas).
--
-- Différence avec l'inbound : pas de création de ticket, pas de pending_review.
-- Un mail envoyé sans match de thread est ignoré silencieusement (aucune ligne
-- email_thread_mapping écrite — on ne stocke pas le courrier perso non lié).
--
-- Settings :
--   sent_mailboxes       : CSV des boîtes dont on scanne les Éléments envoyés.
--                          VIDE par défaut → worker no-op tant que pas configuré
--                          (même convention que mail.inboxes / mail.sender_address,
--                          on ne committe pas d'adresse perso dans le repo).
--   sent_poll_enabled    : kill switch.
--   sent_poll_interval_s : période du worker, en secondes.
INSERT INTO settings (key, value) VALUES
  ('mail.sent_mailboxes',       ''),
  ('mail.sent_poll_enabled',    'false'),
  ('mail.sent_poll_interval_s', '30')
ON CONFLICT (key) DO NOTHING;
