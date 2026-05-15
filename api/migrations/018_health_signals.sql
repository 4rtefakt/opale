-- Migration 018 : signaux de santé OS / sécurité collectés par l'agent Go.
--
-- Stockage en JSONB pour rester schema-flexible : on peut ajouter des
-- nouveaux signaux (SMART, secure_boot, etc.) sans migration. Indexable
-- via GIN si on a besoin de filtrer dessus dans le futur.
--
-- Structure attendue (cf. agent-go/types.go HealthSignals) :
--   {
--     "bitlocker": { "volume": "C:", "enabled": true, "protection_status": "on", "encryption_method": "xts_aes_256" },
--     "defender":  { "antivirus_enabled": true, "realtime_protection": true, "antispyware_enabled": true,
--                    "signature_last_update": "2026-05-09", "signature_age_days": 1 },
--     "firewall":  { "domain_enabled": true, "private_enabled": true, "public_enabled": true },
--     "tpm_present": true,
--     "pending_reboot": false,
--     "last_windows_update": "2026-04-15"
--   }

ALTER TABLE devices ADD COLUMN IF NOT EXISTS health_signals JSONB;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS health_updated_at TIMESTAMPTZ;
