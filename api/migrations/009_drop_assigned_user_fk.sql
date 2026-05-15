-- La FK empêche d'assigner des devices à des utilisateurs AAD non encore connectés au RMM
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_assigned_user_id_fkey;
