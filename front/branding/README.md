# Branding assets

Place les assets visuels propres à ton instance dans ce dossier. Le serveur les
sert via la route `/branding/<asset>` avec **fallback automatique** sur
`front/<asset>` si le fichier n'existe pas ici.

## Fichiers reconnus

| URL servie               | Override (si présent)         | Fallback         |
|--------------------------|-------------------------------|------------------|
| `/branding/icon.svg`     | `front/branding/icon.svg`     | `front/icon.svg` |
| `/branding/favicon.ico`  | `front/branding/favicon.ico`  | `front/favicon.ico` |
| `/branding/login-bg.svg` | `front/branding/login-bg.svg` | `front/login-bg.svg` |

Tout autre nom de fichier dans `front/branding/` est aussi exposé sous
`/branding/<nom>` à condition qu'il corresponde à `[A-Za-z0-9._-]+` (pas de
slash, pas de traversée de chemin).

## Formats supportés

`.svg`, `.png`, `.jpg`, `.jpeg`, `.ico`, `.webp` — le `Content-Type` est
déterminé à partir de l'extension.

## Chemin de bascule

Aucun rebuild n'est requis. Le container monte `front/` en volume :

```bash
rsync -avz front/branding/ root@<host>:/opt/apps/<app>/front/branding/
```

Les nouveaux assets sont visibles immédiatement (cache HTTP `max-age=300`).

## Texte de marque

Le **texte** (nom org, produit, tagline, label rôle par défaut) est servi via
`window.ENV.BRANDING` depuis la table `settings` — modifiable depuis l'UI
Paramètres, sans toucher à des fichiers.
