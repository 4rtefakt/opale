-- Opale — schéma initial

CREATE TABLE IF NOT EXISTS users_cache (
  entra_id     TEXT PRIMARY KEY,
  display_name TEXT,
  email        TEXT,
  job_title    TEXT,
  department   TEXT,
  is_admin     BOOL DEFAULT false,
  synced_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname        TEXT NOT NULL UNIQUE,
  serial          TEXT,
  model           TEXT,
  manufacturer    TEXT,
  cpu             TEXT,
  ram_gb          NUMERIC,
  os              TEXT,
  os_build        TEXT,
  bios_version    TEXT,
  disk_used_pct   NUMERIC,
  ip_netbird      TEXT,
  assigned_user_id TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  last_seen       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  letter     TEXT,
  label      TEXT,
  size_gb    NUMERIC,
  used_pct   NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network_interfaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  mac        TEXT,
  ip         TEXT,
  adapter    TEXT,
  type       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID REFERENCES devices(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  priority    TEXT NOT NULL DEFAULT 'normal',
  device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  is_auto     BOOL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,
  device_id   UUID REFERENCES devices(id) ON DELETE CASCADE,
  message     TEXT,
  threshold   NUMERIC,
  value       NUMERIC,
  created_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scripts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  code        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_executions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id   UUID REFERENCES scripts(id) ON DELETE SET NULL,
  device_id   UUID REFERENCES devices(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  started_at  TIMESTAMPTZ DEFAULT now(),
  duration_ms INTEGER,
  status      TEXT,
  output      TEXT
);

CREATE TABLE IF NOT EXISTS stock_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  category        TEXT,
  quantity        INTEGER NOT NULL DEFAULT 0,
  alert_threshold INTEGER DEFAULT 2,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id   UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  quantity  INTEGER NOT NULL,
  user_id   TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  note      TEXT,
  date      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboardings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name   TEXT NOT NULL,
  email         TEXT,
  role          TEXT,
  contract_type TEXT,
  start_date    DATE,
  end_date      DATE,
  kind          TEXT NOT NULL DEFAULT 'onboard',
  status        TEXT NOT NULL DEFAULT 'in_progress',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboarding_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES onboardings(id) ON DELETE CASCADE,
  step_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  section       TEXT,
  done          BOOL DEFAULT false,
  done_at       TIMESTAMPTZ,
  is_auto       BOOL DEFAULT false
);

CREATE TABLE IF NOT EXISTS automation_costs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type       TEXT NOT NULL UNIQUE,
  label             TEXT,
  estimated_minutes NUMERIC NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT NOT NULL,
  by_user    TEXT,
  target     TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_hostname   ON devices(hostname);
CREATE INDEX IF NOT EXISTS idx_devices_serial     ON devices(serial);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen  ON devices(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_disks_device       ON disks(device_id);
CREATE INDEX IF NOT EXISTS idx_net_device         ON network_interfaces(device_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_device     ON tickets(device_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active      ON alerts(created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_logs(created_at DESC);

INSERT INTO automation_costs (action_type, label, estimated_minutes) VALUES
  ('ticket_auto_create', 'Ticket automatique disque', 3),
  ('disk_cleanup', 'Nettoyage disque manuel', 15),
  ('onboard_account', 'Création compte Entra', 20),
  ('intune_sync', 'Sync Intune forcée', 5),
  ('password_reset', 'Réinitialisation mot de passe', 10)
ON CONFLICT (action_type) DO NOTHING;
