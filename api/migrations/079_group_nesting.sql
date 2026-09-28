-- Groupes imbriqués : un groupe natif peut contenir d'autres groupes
-- (pas seulement des devices/users). Sert à refléter les groupes Entra
-- imbriqués importés, et à composer des groupes Opale entre eux.
--
-- On ajoute member_group_id à group_members. Un membre est désormais
-- EXACTEMENT l'un de : device | user | group. Anti-cycle direct (un groupe
-- ne peut pas se contenir lui-même ; les cycles indirects sont gérés au
-- niveau résolution applicative). Idempotent (drop-then-add des contraintes).

ALTER TABLE group_members ADD COLUMN IF NOT EXISTS member_group_id UUID REFERENCES groups(id) ON DELETE CASCADE;

-- Contrainte de type : exactement un membre parmi les trois.
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS chk_member_type;
ALTER TABLE group_members ADD CONSTRAINT chk_member_type CHECK (
  (device_id       IS NOT NULL)::int
  + (user_id        IS NOT NULL)::int
  + (member_group_id IS NOT NULL)::int = 1
);

-- Un groupe ne peut pas être membre de lui-même (cycle trivial).
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS chk_no_self_group;
ALTER TABLE group_members ADD CONSTRAINT chk_no_self_group CHECK (
  member_group_id IS NULL OR member_group_id <> group_id
);

-- Unicité d'un sous-groupe dans un groupe (index partiel, comme device/user).
CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_uniq
  ON group_members (group_id, member_group_id) WHERE member_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_group_members_member_group
  ON group_members (member_group_id) WHERE member_group_id IS NOT NULL;
