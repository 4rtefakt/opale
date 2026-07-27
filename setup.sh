#!/usr/bin/env bash
#
# Vendorise les dépendances front-end dans front/.
#
# Le front d'Opale n'a ni bundler ni étape de build : il charge directement des
# fichiers statiques. Ce script se contente donc de récupérer quatre
# bibliothèques et de les copier au bon endroit.
#
# ── Pourquoi npm et plus un curl vers un CDN ──────────────────────────────
# Les versions étaient auparavant tirées de jsDelivr avec des plages flottantes
# (`@3`, `@5`, `@4`) et AUCUNE vérification d'intégrité — ni SRI, ni somme de
# contrôle. Trois conséquences :
#
#   • deux builds de la même version d'Opale pouvaient embarquer des fichiers
#     différents (images non reproductibles) ;
#   • rien ne permettait de détecter après coup qu'un build avait récupéré
#     autre chose que prévu, ces fichiers étant par ailleurs gitignorés ;
#   • msal-browser est la brique qui manipule les jetons d'authentification de
#     la console d'administration d'un RMM disposant de SSH, LAPS et de
#     l'exécution de scripts. Une version compromise en amont exfiltrerait les
#     jetons de toutes les instances qui rebuildent.
#
# `npm ci` résout depuis front/package-lock.json, qui épingle les versions
# EXACTES et porte les empreintes d'intégrité SHA-512 de chaque archive. npm
# les vérifie systématiquement : un paquet altéré fait échouer l'installation.
# Bonus, Dependabot suit déjà cet écosystème et proposera les mises à jour.
#
# Pour mettre à jour une bibliothèque : éditer front/package.json, lancer
# `npm install --package-lock-only` dans front/, committer le lockfile.

set -euo pipefail

FRONT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/front"

command -v npm >/dev/null 2>&1 || {
  echo "ERREUR : npm est requis (il fournit la vérification d'intégrité des paquets)." >&2
  exit 1
}

echo "→ Installation des dépendances front épinglées (npm ci)..."
# `npm ci` échoue si package.json et package-lock.json divergent : c'est
# voulu, on ne veut pas d'installation silencieusement différente du lockfile.
(cd "$FRONT" && npm ci --no-audit --no-fund)

MODULES="$FRONT/node_modules"

# Chaque appel : <source dans node_modules> → <destination dans front/>.
# Une source manquante est une ERREUR FATALE : l'ancienne version masquait
# l'échec des polices avec `|| true`, ce qui produisait une interface aux
# icônes absentes sans le moindre message.
copy() {
  local src="$MODULES/$1" dest="$FRONT/$2"
  [ -f "$src" ] || { echo "ERREUR : fichier attendu absent du paquet : $1" >&2; exit 1; }
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "   ✓ $2"
}

echo "→ MSAL Browser (authentification Entra)..."
copy "@azure/msal-browser/lib/msal-browser.min.js" "msal-browser.min.js"

echo "→ Tabler Icons (webfont)..."
copy "@tabler/icons-webfont/dist/tabler-icons.min.css"     "tabler-icons-webfont/tabler-icons.min.css"
copy "@tabler/icons-webfont/dist/fonts/tabler-icons.woff"  "tabler-icons-webfont/fonts/tabler-icons.woff"
copy "@tabler/icons-webfont/dist/fonts/tabler-icons.woff2" "tabler-icons-webfont/fonts/tabler-icons.woff2"

echo "→ xterm.js (terminal SSH / console)..."
copy "@xterm/xterm/lib/xterm.js"  "xterm.js"
copy "@xterm/xterm/css/xterm.css" "styles/xterm.css"

echo "→ Chart.js (page Rapports)..."
copy "chart.js/dist/chart.umd.min.js" "chart.umd.min.js"

echo ""
echo "✓ Dépendances front vendorisées dans $FRONT/"
echo "  Versions épinglées et intégrité vérifiée via front/package-lock.json."
