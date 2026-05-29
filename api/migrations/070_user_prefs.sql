-- Préférences PAR UTILISATEUR (mécanisme réutilisable).
--
-- Jusqu'ici les seuls réglages persistés vivaient dans `settings` (clé/valeur
-- GLOBALE, partagée par tout le monde). Ce besoin-ci est différent : chaque
-- admin doit pouvoir personnaliser SON expérience (ex: les 4 raccourcis de la
-- barre du bas mobile) avec synchro entre appareils. On stocke donc un JSONB
-- libre par user, mergé superficiellement côté API.
--
-- La clé est l'entra_id (FK users_cache, ON DELETE CASCADE) : pas d'id passé
-- par le client, l'API dérive toujours l'identité du token (getUserIdentity).
-- Le contenu du JSONB est validé à la frontière serveur (cf.
-- modules/core/lib/prefs.js) — la DB ne contraint que la forme (objet).

CREATE TABLE IF NOT EXISTS user_prefs (
  entra_id   TEXT PRIMARY KEY REFERENCES users_cache(entra_id) ON DELETE CASCADE,
  prefs      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);
