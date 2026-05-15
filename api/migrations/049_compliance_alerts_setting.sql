-- Toggle "alertes conformité" : push notif admin + création de
-- ticket_proposal quand une règle critical/high transitionne pass→fail.
--
-- Désactivé par défaut : à l'activation initiale, on évite un fan-out
-- massif de pushs/proposals pour les fails déjà connus (le moteur ne
-- déclenche que sur transition, pas sur état stable — mais on reste
-- prudent : un admin a le contrôle explicite avant que ça commence à
-- bipper).
--
-- Activation : UPDATE settings SET value = 'true' WHERE key = 'compliance_alerts_enabled';
-- Ou via PATCH /api/settings (vue Paramètres, à câbler dans une PR future).

INSERT INTO settings (key, value) VALUES
  ('compliance_alerts_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
