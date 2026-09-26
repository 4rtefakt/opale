-- Migration 075 : purge des mots de passe temporaires stockés par l'onboarding.
--
-- Jusqu'ici l'automatisation `create_account` (modules/onboarding) écrivait
-- le mot de passe temporaire du nouveau compte Entra à deux endroits, lisibles
-- par tout utilisateur authentifié via GET /api/onboarding(/:id) :
--
--   1. onboardings.notes, ajouté en fin de notes (séparateur E'\n') sous la
--      forme exacte :
--        Compte créé : <upn>
--        Mot de passe temporaire : <14 caractères de [A-Za-z0-9!@#$], sans espace>
--   2. onboarding_checks.auto_result (TEXT), JSON.stringify de la réponse
--      Graph POST /users augmentée de la clé "temporaryPassword".
--
-- Le code ne stocke plus le mot de passe (renvoyé une seule fois dans la
-- réponse de l'action). Cette migration retire UNIQUEMENT la valeur du mot de
-- passe des lignes existantes :
--   - notes : la valeur après « Mot de passe temporaire : » est remplacée par
--     « [supprimé] » ; le reste des notes (dont « Compte créé : <upn> ») est
--     conservé à l'identique ;
--   - auto_result : la clé temporaryPassword est retirée de l'objet JSON (les
--     autres clés — id, userPrincipalName… — sont conservées). Si la valeur
--     n'est pas un objet JSON lisible (jamais écrit par le code), auto_result
--     est mis à NULL plutôt que de risquer de laisser le mot de passe.
--
-- Idempotente : les deux UPDATE ne sélectionnent que les lignes contenant
-- encore un mot de passe ; un second passage ne touche aucune ligne.

UPDATE onboardings
   SET notes = regexp_replace(
         notes,
         'Mot de passe temporaire : (?!\[supprimé\])\S+',
         'Mot de passe temporaire : [supprimé]',
         'g')
 WHERE notes ~ 'Mot de passe temporaire : (?!\[supprimé\])\S';

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, auto_result FROM onboarding_checks
     WHERE auto_result LIKE '%"temporaryPassword"%'
  LOOP
    BEGIN
      UPDATE onboarding_checks
         SET auto_result = (r.auto_result::jsonb - 'temporaryPassword')::text
       WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE onboarding_checks SET auto_result = NULL WHERE id = r.id;
    END;
  END LOOP;
END $$;
