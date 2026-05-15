CREATE TABLE IF NOT EXISTS ping_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  host            TEXT NOT NULL,
  latency_ms      REAL,
  packet_loss_pct REAL,
  sampled_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ping_device_time ON ping_stats (device_id, sampled_at DESC);
