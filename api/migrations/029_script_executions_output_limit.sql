-- Limite la colonne output à 10 000 caractères (RGPD — minimisation des données)
-- Les données existantes > 10 000 chars sont tronquées
UPDATE script_executions
  SET output = left(output, 10000)
  WHERE length(output) > 10000;

ALTER TABLE script_executions
  ALTER COLUMN output TYPE VARCHAR(10000);
