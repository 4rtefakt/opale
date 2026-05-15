-- Migration 019 : expiration programmée des tokens d'agent.
--
-- Permet la rotation automatique : l'agent demande un nouveau token,
-- le serveur émet le nouveau et programme l'expiration de l'ancien
-- à now() + 24h (grace pour les checkins en vol).
--
-- Sémantique du filtre auth (cf. authToken) :
--   token_hash = ?
--   AND revoked_at IS NULL
--   AND (expires_at IS NULL OR expires_at > now())
--
-- Les tokens existants n'ont pas d'expires_at → valides indéfiniment
-- jusqu'à révocation manuelle ou rotation.

ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS replaced_by UUID REFERENCES agent_tokens(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_tokens_expires_at ON agent_tokens (expires_at) WHERE expires_at IS NOT NULL;
