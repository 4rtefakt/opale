-- Assistant IA des tickets : bouton "Suggérer" qui génère via Ollama une
-- proposition de réponse / prochaine étape de diagnostic, ajoutée au fil
-- comme un message de type 'ai_suggestion' (jamais envoyé par mail).
-- Strictement additif.
--
-- Réutilise l'instance Ollama du classifier mail par défaut, mais settings
-- dédiés pour pouvoir activer/désactiver et choisir un modèle distinct
-- (un modèle de chat plus capable que le classifier si dispo un jour).

INSERT INTO settings (key, value) VALUES
  ('tickets.assistant.enabled', 'true'),
  ('tickets.assistant.url',     'http://ollama:11434'),
  ('tickets.assistant.model',   'qwen2.5:3b')
ON CONFLICT (key) DO NOTHING;
