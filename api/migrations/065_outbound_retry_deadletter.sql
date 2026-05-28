-- Robustesse de l'envoi mail sortant : compteur de tentatives + dead-letter.
-- Strictement additif.
--
-- Avant : un message dont l'envoi échoue laisse email_sent_at NULL → le
-- worker outbound le retente à CHAQUE tick (10s) indéfiniment. Une erreur
-- persistante (mailbox dézappée, perm retirée, contenu rejeté…) boucle à
-- l'infini en spammant les logs et l'API Graph.
--
-- Après : on compte les tentatives. Au-delà de N échecs, le message passe
-- en "dead-letter" (outbound_failed_at posé) — le worker l'ignore, l'admin
-- le voit en échec côté UI et peut relancer manuellement (reset des champs).

ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS outbound_attempts  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outbound_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outbound_error     TEXT;
