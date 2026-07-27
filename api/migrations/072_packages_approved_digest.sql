-- Migration 072 : lie l'approbation d'un package au contenu réellement approuvé.
--
-- Le workflow draft → approved → deploy suppose qu'un admin a relu
-- l'install_script qui s'exécutera en SYSTEM sur le parc. Ce lien n'était
-- qu'implicite : le PATCH ne repassait le package en 'draft' que s'il était
-- DÉJÀ 'approved'. Une modification faite tant que le package était encore en
-- 'draft' — donc entre l'affichage par l'admin et son clic sur « Approuver » —
-- n'invalidait rien.
--
-- `approved_digest` fige le SHA-256 du contenu exécutable au moment de
-- l'approbation (cf. modules/inventory/lib/package-digest.js). Le déploiement
-- recalcule et compare : toute divergence bloque avec un 409.
--
-- Les packages déjà approuvés avant cette migration ont approved_digest NULL.
-- Le code traite ce cas comme « approbation antérieure au contrôle » : le
-- déploiement reste autorisé (pas de régression sur un parc en production),
-- mais la prochaine approbation posera le digest.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS.

ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS approved_digest TEXT;

COMMENT ON COLUMN packages.approved_digest IS
  'SHA-256 du contenu exécutable au moment de l''approbation. NULL = approuvé avant la migration 072.';
