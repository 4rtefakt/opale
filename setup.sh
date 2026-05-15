#!/usr/bin/env bash
# Télécharge les dépendances front-end à self-héberger
set -e

FRONT=front

echo "→ MSAL Browser..."
curl -fsSL "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3/lib/msal-browser.min.js" \
  -o "$FRONT/msal-browser.min.js"

echo "→ Tabler Icons CSS..."
mkdir -p "$FRONT/tabler-icons-webfont/fonts"
curl -fsSL "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css" \
  -o "$FRONT/tabler-icons-webfont/tabler-icons.min.css"
for ext in woff woff2; do
  curl -fsSL "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/fonts/tabler-icons.$ext" \
    -o "$FRONT/tabler-icons-webfont/fonts/tabler-icons.$ext" 2>/dev/null || true
done

echo "→ xterm.js (terminal SSH dans la vue poste)..."
mkdir -p "$FRONT/styles"
curl -fsSL "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.js" \
  -o "$FRONT/xterm.js"
curl -fsSL "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css" \
  -o "$FRONT/styles/xterm.css" 2>/dev/null || true

echo "→ Chart.js v4 UMD (page Rapports)..."
curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js" \
  -o "$FRONT/chart.umd.min.js"

echo ""
echo "✓ Bibliothèques téléchargées dans $FRONT/"
echo ""
echo "Pensez à mettre à jour index.html pour pointer sur les fichiers locaux :"
echo "  <link rel=\"stylesheet\" href=\"/tabler-icons-webfont/tabler-icons.min.css\">"
echo "  (déjà fait pour msal-browser.min.js)"
