-- Branding runtime — clés exposées au front via /env.js (window.ENV.BRANDING).
-- Défauts neutres : chaque instance peut surcharger via UI Paramètres
-- ou via un seed local dédié (cf. instance-local/).

INSERT INTO settings (key, value) VALUES
  ('org.name',               'Your Organization'),
  ('app.product_name',       'Opale'),
  ('app.tagline',            'Open RMM platform'),
  ('app.default_role_label', 'IT')
ON CONFLICT (key) DO NOTHING;
