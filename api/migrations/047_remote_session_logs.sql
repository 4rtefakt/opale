-- Capture du contenu (stdin/stdout/stderr) des sessions remote.
--
-- Le buffer est constitué en mémoire pendant la session côté API et flushé
-- en un SEUL INSERT à la fermeture. Si le serveur crash en cours de session,
-- le log est perdu — accepté (cf. design doc PR capture logs sessions).
--
-- Caps appliqués côté Node :
--   - 10 000 frames max OU 5 MB d'octets bruts décodés
--   - au-delà : truncated=true, on continue à bridger sans plus bufferiser
--
-- frames = JSONB array d'objets { ts_ms, direction, b64 } où :
--   - ts_ms     : ms depuis le début de session
--   - direction : 'in' (browser→agent/SSH) ou 'out' (agent/SSH→browser)
--   - b64       : payload base64 (supporte les ANSI escape codes en bytes bruts)
--
-- size_bytes = total des octets bruts capturés (avant base64), pour les
-- caps RGPD et l'affichage UI ("X KB capturés"). PAS la taille JSON finale.
--
-- ON DELETE CASCADE : si remote_sessions est purgée (rétention 6 mois cf.
-- plugins/cleanup.js), le log suit. La purge dédiée 30 jours du log
-- (plus court que la session parente) est gérée séparément côté plugin.

CREATE TABLE IF NOT EXISTS remote_session_logs (
  session_id   UUID PRIMARY KEY REFERENCES remote_sessions(id) ON DELETE CASCADE,
  frames       JSONB       NOT NULL,
  size_bytes   INTEGER     NOT NULL,
  truncated    BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
