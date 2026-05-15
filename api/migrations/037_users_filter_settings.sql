-- Migration 037 : settings runtime pour filtrer les listings utilisateurs Graph.
--
-- Vide (par défaut) = pas de filtre supplémentaire. Quand `users.filter_attribute`
-- ET `users.filter_value` sont définis, les helpers `getAllAADUsers` et
-- `searchAADUsers` ajoutent `${attr} eq '${val}'` à la clause `$filter` OData.
-- Permet à chaque instance d'appliquer un filtre type "salariés uniquement"
-- (ex: extensionAttribute1=Salarie) sans toucher au code.
--
-- Idempotente : ne réécrase pas une valeur existante.

INSERT INTO settings (key, value) VALUES
  ('users.filter_attribute', ''),
  ('users.filter_value',     '')
ON CONFLICT (key) DO NOTHING;
