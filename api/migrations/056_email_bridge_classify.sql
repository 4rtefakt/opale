-- Phase 2/3 du pont mail ↔ tickets (issue #8) : classification + création de
-- ticket_proposals. Strictement additif : nouvelles colonnes nullables sur
-- email_thread_mapping pour tracer ce que le pipeline a décidé pour chaque
-- mail, plus de nouveaux settings pour la conf du classifieur.
--
-- Aucune nouvelle table : on réutilise `ticket_proposals` existant (source='email')
-- comme cible des mails classés "nouveau ticket".

ALTER TABLE email_thread_mapping
  -- Horodatage du passage dans le pipeline classify+match. NULL = mail
  -- ingéré en Phase 1 avant que le classifieur soit déployé.
  ADD COLUMN IF NOT EXISTS processed_at        TIMESTAMPTZ,

  -- Action prise par le pipeline. Énumération côté code, pas côté SQL,
  -- pour pouvoir ajouter des valeurs sans migration (ex: 'forwarded_to_outbox').
  --   'message_appended'   : mail matché à un ticket existant, message ajouté
  --   'proposal_created'   : ticket_proposal créé (source='email')
  --   'skipped_other'      : classifieur a dit "ce n'est pas un ticket"
  --   'skipped_no_match'   : intent=reply mais aucun ticket trouvé (fallback proposal)
  --   'skipped_error'      : erreur pipeline (cf. error_message)
  ADD COLUMN IF NOT EXISTS action              TEXT,

  -- Lien direct vers la proposition créée, pour la Phase 5 ("ce n'est pas
  -- un ticket" → on retrouve quel mail a déclenché quelle proposition).
  ADD COLUMN IF NOT EXISTS proposal_id         UUID REFERENCES ticket_proposals(id) ON DELETE SET NULL,

  -- Sortie brute du classifieur (intent + confidence + raison textuelle).
  -- Utile pour ré-entraîner / ajuster le prompt sans re-fetcher les mails.
  ADD COLUMN IF NOT EXISTS classifier_result   JSONB,

  ADD COLUMN IF NOT EXISTS error_message       TEXT;

CREATE INDEX IF NOT EXISTS idx_email_mapping_proposal
  ON email_thread_mapping(proposal_id)
  WHERE proposal_id IS NOT NULL;

-- Mails encore à traiter par le pipeline (processed_at NULL) — utile pour
-- la requête "rattrape les mails ingérés mais pas encore classifiés" si
-- le classifieur a été désactivé un moment puis ré-activé.
CREATE INDEX IF NOT EXISTS idx_email_mapping_unprocessed
  ON email_thread_mapping(received_at ASC)
  WHERE processed_at IS NULL;

-- Settings du classifieur. Le pipeline tourne même sans classifieur :
-- fallback_intent (par défaut 'new_ticket') détermine ce qui se passe quand
-- l'IA est désactivée ou en panne. Comme ça, le pont reste utile même
-- pendant une coupure Ollama — on accumule des propositions, le maintainer
-- trie à la main.
INSERT INTO settings (key, value) VALUES
  ('mail.classifier.url',              ''),
  ('mail.classifier.model',            ''),
  ('mail.classifier.enabled',          'false'),
  ('mail.classifier.fallback_intent',  'new_ticket')
ON CONFLICT (key) DO NOTHING;
