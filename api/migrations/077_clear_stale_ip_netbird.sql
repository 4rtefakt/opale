-- Migration 077 : purge des ip_netbird hors de la plage Netbird.
--
-- devices.ip_netbird sert de cible aux connexions SSH lancées par l'API
-- (terminal distant, exécution de scripts, force-checkin, déploiements). Le
-- check-in n'accepte plus qu'une IPv4 de 100.64.0.0/10 (isNetbirdIp,
-- modules/inventory/lib/checkin-validation.js) et stocke NULL sinon, mais
-- les valeurs écrites AVANT ce contrôle restent en base jusqu'au prochain
-- check-in du poste — indéfiniment pour un poste qui ne remonte plus. Un
-- agent compromis a pu y laisser une IP du LAN, 127.0.0.1 ou un nom d'hôte,
-- vers lequel l'API ouvrirait une session SSH avec sa clé.
--
-- Cette migration met à NULL toute valeur non NULL qui n'est pas une IPv4
-- canonique de 100.64.0.0/10, avec la même définition que isNetbirdIp :
-- quatre octets décimaux 0–255 sans zéro de tête, ni espace, ni préfixe.
-- Pas de cast ::inet : une valeur illisible ne doit pas faire échouer le
-- démarrage de l'API. Chaque poste modifié est tracé dans audit_logs
-- (action ip_netbird_cleared, valeur retirée dans details) AVANT la mise à
-- NULL, dans la même transaction.
--
-- Effet sur les postes : un poste concerné n'est plus joignable en SSH
-- (terminal, scripts, force-checkin) jusqu'à son prochain check-in, qui
-- renvoie son IP Netbird si elle est valide.
--
-- Idempotente : après un premier passage, plus aucune ligne ne correspond
-- (le check-in n'écrit plus de valeur hors plage) ; un second passage
-- n'insère ni ne modifie rien.

INSERT INTO audit_logs (action, by_user, target, details)
SELECT 'ip_netbird_cleared',
       'migration 077',
       id::text,
       jsonb_build_object(
         'level',      'warn',
         'hostname',   hostname,
         'ip_netbird', left(ip_netbird, 64)
       )
  FROM devices
 WHERE ip_netbird IS NOT NULL
   AND ip_netbird !~ '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$';

UPDATE devices
   SET ip_netbird = NULL
 WHERE ip_netbird IS NOT NULL
   AND ip_netbird !~ '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$';
