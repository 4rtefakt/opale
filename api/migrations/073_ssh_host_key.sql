-- Épinglage TOFU (trust-on-first-use) de la clé d'hôte SSH par device.
--
-- Les connexions SSH sortantes du serveur (terminal interactif ssh.js,
-- exécution de scripts scripts.js) ciblent devices.ip_netbird — une valeur
-- RAPPORTÉE par l'agent au checkin. Sans vérification de clé d'hôte, un agent
-- compromis rapportant une fausse IP pouvait rediriger une session admin
-- (frappes, mots de passe) vers un hôte contrôlé.
--
-- On mémorise le fingerprint SHA-256 (base64) de la clé d'hôte au premier
-- contact ; les connexions suivantes sont refusées si la clé diffère. Une
-- rotation légitime (réinstall OS) se résout en effaçant la colonne (NULL)
-- pour ré-armer le TOFU.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS ssh_host_key_fp   TEXT,
  ADD COLUMN IF NOT EXISTS ssh_host_key_seen TIMESTAMPTZ;
