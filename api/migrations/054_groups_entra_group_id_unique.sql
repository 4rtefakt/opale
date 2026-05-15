-- Empêche d'importer deux fois le même groupe Entra en deux groupes natifs distincts.
CREATE UNIQUE INDEX IF NOT EXISTS groups_entra_group_id_uniq
  ON groups (entra_group_id)
  WHERE entra_group_id IS NOT NULL;
