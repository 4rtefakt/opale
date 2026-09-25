# Bibliothèques front-end self-hostées

| Fichier                     | Version | Source |
|-----------------------------|---------|--------|
| `msal-browser.min.js`       | 3.30.0  | https://www.npmjs.com/package/@azure/msal-browser |
| `tabler-icons.min.css`      | 3.19.0  | https://github.com/tabler/tabler-icons (webfont) |
| `tabler-icons-webfont/`     | 3.19.0  | Fonts associées aux icônes Tabler |
| `xterm.js`, `styles/xterm.css` | 5.5.0 | https://www.npmjs.com/package/@xterm/xterm |
| `chart.umd.min.js`          | 4.5.1   | https://www.npmjs.com/package/chart.js |

## Téléchargement (via setup.sh)

```bash
bash setup.sh
```

Les versions sont figées et chaque fichier est vérifié par SHA-256 : le
script échoue si le contenu téléchargé ne correspond pas. Pour monter de
version, changer l'URL et l'empreinte dans `setup.sh`, puis ce tableau.

> En développement, le CSS Tabler est chargé depuis jsDelivr (voir `index.html`).
> En production, remplacer par les fichiers self-hostés pour fonctionner hors réseau.
