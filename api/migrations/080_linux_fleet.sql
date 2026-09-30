-- Socle du parc Linux : demandes d'enrôlement séparées des postes approuvés,
-- rapports d'application et secrets de récupération chiffrés.
-- Rejeu sûr sur base peuplée : créations conditionnelles, contraintes gardées,
-- seeds sans écrasement et colonnes devices nullables sans aucun backfill.

CREATE TABLE IF NOT EXISTS linux_device_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID REFERENCES devices(id) ON DELETE CASCADE,
  key_fingerprint   TEXT NOT NULL UNIQUE CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  public_key        BYTEA NOT NULL CHECK (octet_length(public_key) = 32),
  key_backing       TEXT NOT NULL CHECK (key_backing IN ('software', 'tpm')),
  serial_claimed    TEXT,
  hostname_claimed  TEXT,
  os_version        TEXT,
  agent_version     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'preregistration')),
  conflict          JSONB,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  enroll_attempts   INT NOT NULL DEFAULT 1,
  approved_at       TIMESTAMPTZ,
  approved_by       TEXT,
  rejected_at       TIMESTAMPTZ,
  rejected_by       TEXT,
  revoked_at        TIMESTAMPTZ,
  revoked_by        TEXT,
  revoke_reason     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_linux_device_keys_approved
  ON linux_device_keys (device_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_linux_device_keys_status_seen
  ON linux_device_keys (status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_linux_device_keys_serial
  ON linux_device_keys (serial_claimed);

CREATE TABLE IF NOT EXISTS linux_preregistrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial              TEXT NOT NULL UNIQUE,
  hostname            TEXT UNIQUE,
  profile             TEXT NOT NULL,
  ring                TEXT NOT NULL CHECK (ring IN ('pilot', 'stable')),
  assigned_user_id    TEXT,
  note                TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  consumed_at         TIMESTAMPTZ,
  consumed_by_key_id  UUID REFERENCES linux_device_keys(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS linux_apply_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  revision      TEXT CHECK (revision ~ '^[0-9a-f]{40}$'),
  status        TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial', 'skipped')),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error_summary TEXT,
  log_tail      TEXT,
  agent_version TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordre de l'historique défini dans docs/linux-fleet-design.md §2.
CREATE INDEX IF NOT EXISTS idx_linux_apply_reports_device_started
  ON linux_apply_reports (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_linux_apply_reports_success_revision
  ON linux_apply_reports (revision) WHERE status = 'success';

CREATE TABLE IF NOT EXISTS device_recovery_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('luks_recovery', 'tpm_owner')),
  label           TEXT NOT NULL,
  ciphertext      BYTEA NOT NULL,
  key_id          TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  superseded_at   TIMESTAMPTZ,
  last_viewed_at  TIMESTAMPTZ,
  last_viewed_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_recovery_keys_device_created
  ON device_recovery_keys (device_id, created_at DESC);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS platform                 TEXT,
  ADD COLUMN IF NOT EXISTS managed_by               TEXT,
  ADD COLUMN IF NOT EXISTS profile                  TEXT,
  ADD COLUMN IF NOT EXISTS ring                     TEXT,
  ADD COLUMN IF NOT EXISTS last_revision_applied    TEXT,
  ADD COLUMN IF NOT EXISTS last_successful_revision TEXT,
  ADD COLUMN IF NOT EXISTS last_apply_status        TEXT,
  ADD COLUMN IF NOT EXISTS last_apply_at            TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('windows', 'linux', 'macos'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_managed_by_check CHECK (managed_by IN ('pull'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_ring_check CHECK (ring IN ('pilot', 'stable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_devices_managed_pull
  ON devices (managed_by) WHERE managed_by = 'pull';

INSERT INTO settings (key, value) VALUES
  ('linux.repo_url', ''),
  ('linux.ring.pilot', '{"branch":"main"}'),
  ('linux.ring.stable', '{"branch":"main"}'),
  ('linux.allowed_signers', '[]'),
  ('linux.alerts_enabled', 'false'),
  ('linux.escrow_backup_confirmed', '')
ON CONFLICT (key) DO NOTHING;
