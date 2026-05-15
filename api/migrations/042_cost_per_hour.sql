-- Migration 042 : remplace annual_salary_brut par cost_per_hour (€/heure).
-- Formule de conversion : salaire_annuel / 1 442 (206j × 7h).
-- La valeur par défaut (32500 / 1442 ≈ 22.54) est insérée si annual_salary_brut
-- n'existe pas encore.

INSERT INTO settings (key, value, updated_at, updated_by)
SELECT
  'cost_per_hour',
  ROUND((COALESCE(
    (SELECT value::numeric FROM settings WHERE key = 'annual_salary_brut'),
    32500
  ) / 1442)::numeric, 2)::text,
  now(),
  'migration-042'
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings WHERE key = 'annual_salary_brut';
