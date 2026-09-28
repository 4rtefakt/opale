-- Points informatiques (revues périodiques présentées à la hiérarchie).
--
-- Un « point » = un document daté qui combine :
--   - snapshot : les métriques figées au moment de la sauvegarde (parc,
--     tickets, pont mail, temps économisé…). Assemblé côté front à partir des
--     endpoints existants (dashboard / email / rapports) puis stocké tel quel.
--     JSONB opaque : la forme appartient au front, la DB ne fait que persister.
--   - sections : les paragraphes rédigés à la main ([{ heading, body }],
--     ordonnés) — incidents, matériel, sujets en attente, etc.
--
-- Historisé : chaque point reste consultable (lien partageable #/point/<id>).
-- Idempotent (CREATE … IF NOT EXISTS) pour le rejouage CI.

CREATE TABLE IF NOT EXISTS reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL,
  period_start        DATE,
  period_end          DATE,
  snapshot            JSONB NOT NULL DEFAULT '{}',
  sections            JSONB NOT NULL DEFAULT '[]',
  created_by_entra_id TEXT,
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews (created_at DESC);
