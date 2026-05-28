-- Page Rapports : enrichit la liste des actions automatisées prises en
-- compte dans le KPI "temps / argent économisé". Strictement additif.
--
-- Contexte : le KPI fait un INNER JOIN audit_logs × automation_costs, donc
-- toute action auditée sans mapping est invisible dans le calcul. Plusieurs
-- automatisations réellement émises en prod (console distante, détection de
-- conformité, gestion de groupes Entra, LAPS consulté, etc.) n'avaient pas
-- de ligne ici → leur gain de temps n'était pas comptabilisé.
--
-- Durées : forfaits conservateurs (on préfère sous-estimer le gain pour
-- garder le KPI crédible). Sessions distantes (console/SSH/takeover) à 10 min
-- forfaitaires par ouverture, indépendamment de la durée réelle.
--
-- Volontairement NON mappées (traçabilité pure, pas d'économie mesurable) :
--   agent_checkin (déjà couvert par agent_checkin_summary), agent_ws_*,
--   setup_script, agent_bootstrap_exchange, token_*/cli_token_*,
--   admin_granted/revoked, alert_snooze, network_view_accessed,
--   group_updated, users_synced_all.

INSERT INTO automation_costs (action_type, label, estimated_minutes) VALUES
  ('compliance_changed',        'Changement de conformité détecté',        5),
  ('tamper_detected',           'Sabotage agent détecté',                 10),
  ('agent_console_open',        'Console distante ouverte',               10),
  ('agent_console_takeover',    'Prise en main console distante',         10),
  ('ssh_open',                  'Session SSH distante',                   10),
  ('group_synced_from_entra',   'Groupe synchronisé depuis Entra',         8),
  ('group_imported_from_entra', 'Groupe importé depuis Entra',            10),
  ('laps_viewed',               'Mot de passe LAPS consulté à distance',  15),
  ('device_deleted',            'Poste retiré de l''inventaire',           5)
ON CONFLICT (action_type) DO NOTHING;
