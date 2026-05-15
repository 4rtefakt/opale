-- Bootstrap tokens : quota d'usages maximum.
--
-- Le bootstrap_redeemed_count existant (036) servait d'audit trail mais
-- n'était plafonné nulle part — un bootstrap leaké pouvait être rejoué
-- ad libitum jusqu'à expiration.
--
-- bootstrap_max_redeems = NULL  → illimité (compat des bootstraps existants
--                                  qui auraient pu dépasser un quota arbitraire,
--                                  et pour les setup keys de très gros déploiements).
-- bootstrap_max_redeems = N     → le bootstrap accepte au plus N exchanges.
--
-- La vérification (count < max) est faite côté API dans /exchange-token,
-- enveloppée dans une transaction pour sérialiser les exchanges concurrents.

ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS bootstrap_max_redeems INTEGER;
