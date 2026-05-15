-- Groupes natifs — PR 1 du chantier "système de groupes natifs".
--
-- Deux tables :
--   groups       — définition du groupe (nom, couleur, source)
--   group_members — membres (device OU user, jamais les deux nuls)
--
-- source = 'native' pour les groupes créés dans Opale. La valeur 'entra'
-- est réservée à la PR 4 (sync optionnel Entra → natif) ; aucune route
-- ne peut créer un groupe avec source='entra' via le CRUD standard.
--
-- user_id est une référence molle vers users_cache.entra_id (TEXT, pas de FK).
-- Une FK avec ON DELETE CASCADE viderait les memberships lors d'une purge
-- du cache Entra, comportement indésirable. L'entra_id est l'identifiant
-- stable de l'utilisateur, le cache est volatile.

CREATE TABLE IF NOT EXISTS groups (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  color       TEXT    CHECK (color IN ('slate','blue','green','amber','red','violet','pink','teal')),
  source      TEXT    NOT NULL DEFAULT 'native' CHECK (source IN ('native','entra')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  created_by  TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  user_id   TEXT,
  added_at  TIMESTAMPTZ DEFAULT now(),
  added_by  TEXT,
  CONSTRAINT chk_member_type CHECK (device_id IS NOT NULL OR user_id IS NOT NULL)
);

-- Index partiels pour garantir l'unicité sans contraindre les NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_device_uniq
  ON group_members (group_id, device_id) WHERE device_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS group_members_user_uniq
  ON group_members (group_id, user_id) WHERE user_id IS NOT NULL;
