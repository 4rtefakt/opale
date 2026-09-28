# Démo publique d'Opale

Une instance d'Opale qui tourne sans rien derrière : le front est servi tel
quel depuis `front/`, et l'API est remplacée par une version factice en
mémoire (`api.js` + `seed.js`) sur un Cloudflare Worker. Les visiteurs
peuvent tout essayer — trier les mails, répondre à un ticket, déployer un
package — sans compte Microsoft et sans rien installer.

- **Aucune donnée réelle** : noms, postes et mails sont inventés (`seed.js`).
- **Un jeu de données par visiteur** (cookie `opale_demo`), remis à zéro après
  2 h d'inactivité ou via « Réinitialiser » dans le bandeau. Rien n'est
  persisté.
- **Ce qui n'existe pas dans la démo** répond 403 avec un message clair : SSH,
  console SYSTEM, import Entra, pièces jointes, envoi de mails réel.

## Lancer en local

```bash
./setup.sh                      # vendorise polices, icônes, MSAL dans front/
cd demo && npm install && npm run dev
# → http://localhost:8788  (desktop)   http://localhost:8788/mobile.html
```

`npm test` vérifie l'API factice (routes, formes de réponse, mutations).

## Déployer sur Cloudflare

Une seule fois, dans Cloudflare : créer un jeton API avec le modèle « Edit
Cloudflare Workers », puis ajouter au dépôt GitHub les secrets
`CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`. Le workflow
`.github/workflows/deploy-demo.yml` déploie ensuite à chaque push sur `main`
qui touche `front/` ou `demo/` (et à la demande, onglet Actions).

À la main :

```bash
./setup.sh
cd demo && npm install
npx wrangler login          # ou CLOUDFLARE_API_TOKEN=… dans l'environnement
npm run deploy
```

Le Worker est publié sur `https://opale-demo.<sous-domaine>.workers.dev` ;
un domaine personnalisé se branche dans le tableau de bord Cloudflare
(Workers → opale-demo → Settings → Domains & Routes). Renseigner ensuite
l'URL dans `landing/index.html` (`DEMO_URL`) pour afficher le bouton
« Try the live demo ».

## Fonctionnement

| Chemin | Servi par |
|---|---|
| `/env.js` | le Worker : `ENV.DEMO = true`, pas d'identifiants Entra, branding « Démo Opale » |
| `/manifest.json`, `/branding/*` | le Worker |
| `/api/*` | `api.js` sur l'état du visiteur (`seed.js`) |
| tout le reste | les fichiers de `front/` (assets statiques Cloudflare) |

Côté front, `ENV.DEMO` fait deux choses : `auth.js` fournit un compte
fictif au lieu de MSAL, et `app.js` / `mobile-app.js` affichent le bandeau
« Démo ». Aucun autre chemin du front ne connaît la démo.
