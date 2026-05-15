-- Stocke l'identifiant Entra du groupe source quand un groupe natif est
-- importé depuis Entra. Permet le re-sync (rafraîchissement des membres)
-- et le détachement (effacement de cette colonne + source → 'native').

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS entra_group_id TEXT;
