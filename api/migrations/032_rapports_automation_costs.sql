-- Page Rapports : extension automation_costs + paramètre salaire annuel.
-- Strictement additif.

INSERT INTO automation_costs (action_type, label, estimated_minutes) VALUES
  ('rmm_force_checkin',      'Diagnostic forcé à distance',         8),
  ('intune_force_sync',      'Sync Intune depuis le RMM',           3),
  ('laps_rotated',           'Rotation LAPS automatique',          12),
  ('package_deployed',       'Déploiement de package silencieux',  25),
  ('script_executed_remote', 'Script lancé à distance',            15),
  ('agent_checkin_summary',  'Inventaire automatique mensuel',     20)
ON CONFLICT (action_type) DO NOTHING;

-- Salaire annuel brut servant au calcul du temps épargné en €.
-- Default 32500 (~19.34 €/h sur base 20j × 7h × 12 mois = 1 680h).
INSERT INTO settings (key, value) VALUES
  ('annual_salary_brut', '32500')
ON CONFLICT (key) DO NOTHING;
