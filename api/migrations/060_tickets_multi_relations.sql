-- Phase 2 refonte tickets : multi-relations users/devices + merge.
--
-- Avant : tickets.user_id (1 requester) + tickets.device_id (1 poste).
-- Après : ticket_users (N personnes avec un role) + ticket_devices (N postes).
-- Les colonnes tickets.user_id / tickets.device_id restent en place pour
-- compat lecture (vues, agrégations existantes), maintenues en dual-write
-- par les routes. Drop dans une migration 061 séparée, après vérif prod que
-- toutes les vues lecture sont migrées.

-- ── ticket_users : M2M tickets ↔ users_cache avec un role ──────────────────
-- role :
--   'requester' = celui qui a ouvert / pour qui le ticket est créé (1 seul max)
--   'involved'  = autres personnes concernées (CC, équipe, manager, etc.)
CREATE TABLE IF NOT EXISTS ticket_users (
  ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_entra_id TEXT NOT NULL REFERENCES users_cache(entra_id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'involved',
  added_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ticket_id, user_entra_id)
);

-- Au plus UN requester par ticket. Index unique partiel sur role.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ticket_users_one_requester
  ON ticket_users(ticket_id)
  WHERE role = 'requester';

CREATE INDEX IF NOT EXISTS idx_ticket_users_user
  ON ticket_users(user_entra_id);

-- ── ticket_devices : M2M tickets ↔ devices ─────────────────────────────────
-- Pas de role : un device est concerné ou ne l'est pas, sans hiérarchie.
CREATE TABLE IF NOT EXISTS ticket_devices (
  ticket_id UUID NOT NULL REFERENCES tickets(id)  ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id)  ON DELETE CASCADE,
  added_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ticket_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_devices_device
  ON ticket_devices(device_id);

-- ── merged_into : pour les tickets fusionnés ───────────────────────────────
-- Le source garde status='merged' + merged_into=target. Front redirige
-- l'ouverture d'un ticket merged vers le target avec un toast.
-- ON DELETE SET NULL : si le target est supprimé un jour, le source reste
-- accessible (status='merged' avec merged_into NULL) plutôt que disparaître.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_merged_into
  ON tickets(merged_into)
  WHERE merged_into IS NOT NULL;

-- ── Backfill data depuis les colonnes existantes ───────────────────────────
-- tickets.user_id → ticket_users (role='requester'). ON CONFLICT DO NOTHING
-- pour permettre la re-run de la migration (idempotence) si jamais.
INSERT INTO ticket_users (ticket_id, user_entra_id, role)
SELECT id, user_id, 'requester'
FROM tickets
WHERE user_id IS NOT NULL
ON CONFLICT (ticket_id, user_entra_id) DO NOTHING;

INSERT INTO ticket_devices (ticket_id, device_id)
SELECT id, device_id
FROM tickets
WHERE device_id IS NOT NULL
ON CONFLICT (ticket_id, device_id) DO NOTHING;
