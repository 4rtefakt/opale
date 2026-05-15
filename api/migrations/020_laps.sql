-- Migration 020 : LAPS-like — credential admin local rotaté + escrow chiffré.
--
-- L'agent rotate le password d'un compte LOCAL DÉDIÉ ("opale-recovery"
-- par défaut, configurable). Ne touche JAMAIS les comptes admins existants.
-- Le password est chiffré en RSA-OAEP-SHA256 avec une clé publique
-- embarquée dans le binaire ; la clé privée vit côté serveur uniquement.
--
-- Le serveur ne peut décrypter que via /api/devices/:id/admin-credential
-- (auth admin), chaque accès est audit logé.

CREATE TABLE IF NOT EXISTS device_admin_credentials (
  device_id              UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  username               TEXT NOT NULL DEFAULT 'opale-recovery',
  encrypted_password     BYTEA NOT NULL,
  password_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotation_requested_at  TIMESTAMPTZ,
  last_viewed_at         TIMESTAMPTZ,
  last_viewed_by         TEXT REFERENCES users_cache(entra_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_creds_rotation_requested
  ON device_admin_credentials (device_id)
  WHERE rotation_requested_at IS NOT NULL;
