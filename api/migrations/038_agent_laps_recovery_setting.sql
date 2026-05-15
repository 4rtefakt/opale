-- Migration 038 : nom du compte LAPS recovery — runtime configurable.
--
-- Le défaut neutre est `opale-recovery`. L'agent Go lit cette valeur via
-- GET /api/agent/runtime-config au démarrage et à chaque checkin ;
-- fallback sur la constante de build `branding.LAPSDefaultUser` si
-- l'endpoint est indisponible.
--
-- Chaque instance peut surcharger via UI Paramètres ou via un seed local
-- (cf. instance-local/).
--
-- Idempotente : ne réécrase pas une valeur existante.

INSERT INTO settings (key, value) VALUES
  ('agent.laps_recovery_username', 'opale-recovery')
ON CONFLICT (key) DO NOTHING;
