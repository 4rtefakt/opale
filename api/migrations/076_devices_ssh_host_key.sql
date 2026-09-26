-- Migration 076 : mémorisation des clés d'hôte SSH par poste (TOFU).
--
-- `ssh2` accepte n'importe quelle clé d'hôte quand aucun `hostVerifier` n'est
-- passé, et Opale n'en passait aucun (routes/ssh.js, routes/scripts.js,
-- routes/devices.js force-checkin). Il n'existait par ailleurs aucun
-- known_hosts côté serveur : le mesh VPN était traité comme un périmètre de
-- confiance, alors même que les IP y sont réattribuables.
--
-- Ces colonnes portent l'empreinte apprise au premier contact et la date de
-- cet apprentissage. Le code (modules/remote/lib/ssh-host-key.js) refuse
-- ensuite toute clé différente ; un admin réinitialise l'empreinte depuis la
-- fiche du poste après une réinstallation légitime.
--
-- Reprise de la migration 074 de la branche
-- claude/tool-security-architecture-review-s8j0am, renumérotée.
-- Rejouable (ADD COLUMN IF NOT EXISTS, COMMENT idempotent).

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS ssh_host_key_fp         TEXT,
  ADD COLUMN IF NOT EXISTS ssh_host_key_learned_at TIMESTAMPTZ;

COMMENT ON COLUMN devices.ssh_host_key_fp IS
  'Empreinte SHA-256 (base64) de la clé d''hôte SSH, apprise au premier contact. NULL = jamais contacté.';
