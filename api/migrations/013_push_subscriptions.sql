CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_entra_id TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  subscription  JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_entra_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_entra_id);
