-- Remote sessions : journal unifié des accès distants à un poste (SSH ou
-- console-via-agent). Remplace `ssh_sessions` qui ne portait que SSH ; le
-- besoin grandit avec l'ajout de la console-via-agent (PR 2 console-via-
-- agent), et plutôt que d'empiler des `transport`/`shell` sur la table
-- existante on repart d'un schéma propre.
--
-- transport ∈ ('ssh','agent_console') :
--   - ssh           : tunnel SSH via Netbird (vers compte local non-admin)
--   - agent_console : ConPTY spawné par l'agent SYSTEM (priv. plus large)
--
-- takeover_of : pointe sur la session que cette nouvelle session a forcée
-- à fermer (cas où un admin "Prend la main" alors qu'une autre session est
-- déjà active sur le poste). Permet de tracer la chaîne d'éviction dans
-- l'audit.

CREATE TABLE IF NOT EXISTS remote_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID REFERENCES devices(id) ON DELETE CASCADE,
  transport    TEXT NOT NULL CHECK (transport IN ('ssh','agent_console')),
  by_entra_id  TEXT,
  by_name      TEXT,
  ip           TEXT,                 -- rempli pour ssh, NULL pour agent_console
  shell        TEXT,                 -- rempli pour agent_console (ex: powershell.exe)
  started_at   TIMESTAMPTZ DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT,
  takeover_of  UUID REFERENCES remote_sessions(id) ON DELETE SET NULL
);

-- Migration des rows historiques. ssh_sessions n'aura plus que la transport
-- "ssh" ; on copie en préservant les IDs pour ne pas casser d'éventuelles
-- références externes (audit_logs.target, exports, etc.). Idempotent : si
-- la table source a déjà été archivée par un premier run, on saute.
--
-- On RENAME la table source en ssh_sessions_archive_pre046 au lieu de DROP :
-- rollback en 1 seule commande SQL si on découvre un bug dans la migration
-- INSERT (les rows historiques sont préservées en plus du pg_dump backup).
-- La table sera supprimable plus tard quand le nouveau schéma aura prouvé
-- sa stabilité (migration de cleanup dédiée).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ssh_sessions'
  ) THEN
    INSERT INTO remote_sessions (id, device_id, transport, by_entra_id, by_name, ip, started_at, ended_at)
    SELECT id, device_id, 'ssh', by_entra_id, by_name, ip, started_at, ended_at
    FROM ssh_sessions
    ON CONFLICT (id) DO NOTHING;

    ALTER TABLE ssh_sessions RENAME TO ssh_sessions_archive_pre046;
  END IF;
END $$;

-- Index partiel pour la vérification "y a-t-il une session active sur ce
-- device ?" effectuée à chaque POST /api/console/grant. Reste compact car
-- les sessions actives sont rares (quelques unités au plus).
CREATE INDEX IF NOT EXISTS idx_remote_sessions_active
  ON remote_sessions (device_id) WHERE ended_at IS NULL;

-- Index pour la liste chronologique par device (vue "historique des accès"
-- côté UI, à venir).
CREATE INDEX IF NOT EXISTS idx_remote_sessions_device_started
  ON remote_sessions (device_id, started_at DESC);
