CREATE TABLE IF NOT EXISTS bandwidth_stats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  adapter    TEXT NOT NULL,
  bytes_sent BIGINT,
  bytes_recv BIGINT,
  sampled_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bw_device_time ON bandwidth_stats (device_id, sampled_at DESC);
