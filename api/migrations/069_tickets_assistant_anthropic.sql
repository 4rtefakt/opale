-- Assistant IA des tickets (suggestion de réponse / diagnostic) : bascule du
-- backend Ollama vers Claude Haiku.
--
-- ⚠ Ne concerne QUE l'assistant tickets. Le classifieur de mails entrants
-- (email-bridge) reste sur Ollama — backend indépendant, non touché ici.
--
-- Nouveau réglage `tickets.assistant.provider` (ollama|anthropic). La clé API
-- est partagée avec Ask Opale via l'env OPALE_ASK_API_KEY (jamais en settings).
-- On ne touche pas `tickets.assistant.url` (reste l'URL Ollama) : elle est
-- ignorée quand provider=anthropic (endpoint Claude par défaut) et reste donc
-- disponible telle quelle si on rebascule un jour sur Ollama.

INSERT INTO settings (key, value) VALUES
  ('tickets.assistant.provider', 'anthropic')
ON CONFLICT (key) DO NOTHING;

-- Modèle par défaut → Claude Haiku 4.5 (cohérent avec Ask Opale).
UPDATE settings SET value = 'claude-haiku-4-5-20251001'
WHERE key = 'tickets.assistant.model';
