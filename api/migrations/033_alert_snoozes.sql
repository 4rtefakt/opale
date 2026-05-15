-- Snooze d'alertes par device + type. Un seul snooze actif par couple
-- (device_id, alert_type). Au-delà de until_at, l'alerte réapparaît normalement.
-- L'historique d'usage est tracé via audit_logs.

CREATE TABLE IF NOT EXISTS alert_snoozes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id            UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  alert_type           TEXT NOT NULL,
  until_at             TIMESTAMPTZ NOT NULL,
  reason               TEXT,
  created_by_entra_id  TEXT,
  created_by_name      TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),

  UNIQUE (device_id, alert_type)
);

CREATE INDEX IF NOT EXISTS idx_alert_snoozes_until       ON alert_snoozes(until_at);
CREATE INDEX IF NOT EXISTS idx_alert_snoozes_device_type ON alert_snoozes(device_id, alert_type);
