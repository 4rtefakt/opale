-- Devices : horodatage de la dernière connexion WebSocket persistante.
--
-- Distinct de devices.last_seen (qui trace les checkins HTTP 15min). La WS
-- agent ↔ serveur (cf. routes/agent.js → /api/agent/ws) sert de canal de
-- contrôle temps réel pour la console interactive et, à terme, d'autres
-- commandes synchrones. Ce timestamp permet :
--
--   1. à /api/console/grant (PR 2) de refuser proprement si l'agent n'est pas
--      actuellement connecté en WS,
--   2. à l'UI de différencier "agent vivant côté polling" (last_seen frais)
--      de "agent réactif temps réel" (last_seen_ws frais).
--
-- NULL = l'agent n'a jamais établi de connexion WS (cas des agents pré-2.13).
-- Mis à jour au connect ET au close pour avoir une borne supérieure utile
-- même hors fenêtre de connexion active.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS last_seen_ws TIMESTAMPTZ;
