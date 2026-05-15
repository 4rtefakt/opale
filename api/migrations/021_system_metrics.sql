-- Migration 021 : métriques système (Pass 10a — RAM/CPU/uptime/batterie/HW).
--
-- Deux dimensions :
--   • Statique-ish (cores, mainboard, GPU, monitors, current_user) →
--     JSONB sur devices, mis à jour à chaque checkin via COALESCE
--   • Time-series (RAM%, CPU%, batterie%, uptime) → table dédiée
--     comme bandwidth_stats / ping_stats, retention 7 jours

ALTER TABLE devices ADD COLUMN IF NOT EXISTS system_info JSONB;

CREATE TABLE IF NOT EXISTS system_perf_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ram_used_gb     NUMERIC(7,2),
  ram_total_gb    NUMERIC(7,2),
  ram_used_pct    NUMERIC(5,2),
  cpu_avg_pct     NUMERIC(5,2),
  cpu_max_pct     NUMERIC(5,2),
  uptime_seconds  BIGINT,
  battery_pct     INT,
  battery_status  TEXT,
  sampled_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sysperf_device_sampled
  ON system_perf_stats (device_id, sampled_at DESC);
