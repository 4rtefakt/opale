-- Vue Stock : tracer le destinataire d'un mouvement de stock.
-- Strictement additif.
--
-- Avant : stock_movements.user_id contenait l'admin qui faisait le geste
-- (redondant avec by_name). Pas moyen de noter À QUI part un consommable.
--
-- Après : deux colonnes destinataire, toutes deux optionnelles :
--   - recipient_user_id : si le destinataire est dans l'annuaire (FK
--     users_cache), pour permettre des stats "qui a reçu quoi".
--   - recipient_label   : texte libre, pour les destinataires hors annuaire
--     (atelier, prêt temporaire, prestataire externe…) ou quand on ne veut
--     pas piocher dans l'annuaire.
-- Les deux peuvent être nuls (sortie sans destinataire précis).
-- user_id (auteur) est conservé tel quel pour ne rien casser.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS recipient_user_id TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_label   TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_movements_recipient
  ON stock_movements(recipient_user_id)
  WHERE recipient_user_id IS NOT NULL;
