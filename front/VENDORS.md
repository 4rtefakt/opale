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

`styles/xterm.css` est aussi suivi par git (ancienne copie 5.x conservée
telle quelle) : `setup.sh` l'écrase par la version 5.5.0 vérifiée. Ne pas
modifier la copie suivie — sur les installations existantes elle est déjà
modifiée localement par `setup.sh`, et tout changement côté git ferait
échouer leur `git pull`.

> `index.html` et `mobile.html` chargent ces fichiers depuis `front/` (aucun
> CDN au runtime) : lancer `setup.sh` aussi en développement.
