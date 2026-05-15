-- Bootstrap tokens : un token "fleet" partagé qui sert UNIQUEMENT à
-- s'échanger contre un token perso device-lié au premier contact.
--
-- Pattern Tailscale/Netbird "setup key" : le bootstrap est embarqué dans le
-- script de déploiement Intune (1 script pour N PCs). Au runtime, le script
-- appelle POST /api/agent/exchange-token qui :
--   1. Valide le bootstrap (is_bootstrap=true, non révoqué, expires_at > now())
--   2. Génère un token perso, le lie au device matchant le hostname
--   3. Retourne le token perso au PC (sans expiration par défaut)
--   4. Incrémente bootstrap_redeemed_count pour audit
--
-- Le bootstrap reste valide pour d'autres exchanges jusqu'à expires_at
-- (recommandé : 7 jours), puis devient inutilisable. Les tokens persos
-- générés via exchange survivent à la révocation du bootstrap.
--
-- expires_at existe déjà (colonne ajoutée pour la rotation), on l'utilise
-- pour borner la validité du bootstrap.

ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS is_bootstrap              BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bootstrap_redeemed_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bootstrap_redeemed_at     TIMESTAMPTZ;

-- Index pour retrouver le bootstrap actif rapidement.
CREATE INDEX IF NOT EXISTS idx_agent_tokens_bootstrap_active
  ON agent_tokens (is_bootstrap, expires_at)
  WHERE is_bootstrap = TRUE;
