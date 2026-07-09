-- Déduplication des alertes tamper.
--
-- Le rapport tamper de l'agent est "collant" : fixé au boot, il est renvoyé à
-- CHAQUE checkin (~15 min) tant que le baseline n'est pas ré-établi. Sans
-- mémoire côté serveur, chaque checkin re-loggait `tamper_detected` et
-- renvoyait une push → inondation du journal pour un seul poste concerné.
--
-- On mémorise le dernier hash `actual` alerté par device : on ne log/push que
-- lorsque l'état change (nouveau hash, ou retour à la normale), pas à chaque
-- checkin répétant le même tamper.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS last_tamper_hash TEXT;
