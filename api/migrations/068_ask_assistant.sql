-- Ask Opale — recherche/interrogation du parc en langage naturel.
--
-- Le LLM traduit une question FR en QuerySpec (validé strictement côté
-- serveur) puis le moteur déterministe compile en SQL paramétré. v1 :
-- lecture seule (devices / tickets / compliance), pas d'action.
--
-- Settings = config NON secrète uniquement. La clé API ne vit PAS ici : elle
-- est lue depuis l'env OPALE_ASK_API_KEY. Raison : GET /api/settings renvoie
-- toutes les clés aux admins (cf. core/routes/settings.js) — y mettre un
-- secret le ferait fuiter. « Mur dur sur les secrets ».
--
-- Provider abstrait (mistral|anthropic) : model/url/key configurables. Défaut
-- = Claude Haiku 4.5, retenu après benchmark (eval/ : ~100% de traduction
-- correcte sur 33 questions FR réelles). Activé par défaut : tant que la clé
-- env OPALE_ASK_API_KEY n'est pas posée, la route répond 503 « non configuré »
-- proprement (aucun effet de bord). url vide → endpoint Anthropic par défaut.

INSERT INTO settings (key, value) VALUES
  ('ask.enabled',  'true'),
  ('ask.provider', 'anthropic'),
  ('ask.url',      ''),
  ('ask.model',    'claude-haiku-4-5-20251001')
ON CONFLICT (key) DO NOTHING;
