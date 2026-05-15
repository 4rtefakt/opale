-- Compliance Dashboard v1 — verdict par règle/device.
--
-- Un seul row par couple (device_id, rule_id) : remplacé à chaque checkin
-- de l'agent (UPSERT). Pas de table d'historique : les transitions
-- pass↔fail sont loggées dans audit_logs (action = 'compliance_changed'),
-- ce qui permet de reconstruire la timeline d'un device sans grossir une
-- time-series dédiée.
--
-- Set fixe de règles en code (api/lib/compliance.js), pas modifiable via UI.
-- rule_id = slug stable (ex 'bitlocker_c_active'). severity stockée pour
-- snapshoter la sévérité au moment de l'éval (le code peut la changer plus
-- tard sans réécrire l'historique).
--
-- status :
--   'pass'           : règle satisfaite
--   'fail'           : règle violée
--   'not_applicable' : donnée manquante (ex: agent n'a pas remonté ce signal,
--                      device pas Intune-enrolled, etc.) — distinct de 'fail'
--                      pour éviter les faux positifs au déploiement d'une
--                      nouvelle version d'agent.
--
-- value : { actual, expected } JSON pour drill-down UI ; nullable si la
-- règle n'a pas besoin de contexte (ex: pass d'un bool simple).
--
-- ON DELETE CASCADE : un device supprimé emporte ses résultats.

CREATE TABLE IF NOT EXISTS compliance_results (
  device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  rule_id      TEXT         NOT NULL,
  status       TEXT         NOT NULL CHECK (status IN ('pass','fail','not_applicable')),
  severity     TEXT         NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  value        JSONB,
  evaluated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, rule_id)
);

-- Aggregate par règle pour le dashboard global : count(*) WHERE rule_id=…
CREATE INDEX IF NOT EXISTS idx_compliance_results_rule_status
  ON compliance_results(rule_id, status);

-- Liste des fails ordonnée par sévérité — pour les drill-downs et le
-- "top postes les moins conformes".
CREATE INDEX IF NOT EXISTS idx_compliance_results_fail
  ON compliance_results(severity, rule_id) WHERE status = 'fail';
