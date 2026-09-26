#!/usr/bin/env bash
# Télécharge les dépendances front-end à self-héberger.
#
# Versions figées et empreintes SHA-256 vérifiées : un fichier modifié côté
# CDN (compromission, republication) fait échouer le script au lieu d'être
# servi aux admins. Empreintes relevées sur cdn.jsdelivr.net et recoupées
# avec le contenu des tarballs du registre npm (intégrité sha512 vérifiée).
# Pour monter de version : changer l'URL ET l'empreinte, puis mettre à jour
# front/VENDORS.md.
set -euo pipefail

FRONT=front

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1   # macOS
  fi
}

# Téléchargements dans un dossier temporaire hors de front/, supprimé à la
# sortie quelle qu'en soit la cause (succès, échec curl, empreinte fausse,
# Ctrl-C) : aucun fichier partiel ne reste ni n'est servi.
TMP_DL="$(mktemp -d)"
trap 'rm -rf "$TMP_DL"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# fetch URL DESTINATION SHA256 — télécharge dans $TMP_DL, vérifie l'empreinte,
# puis remplace la destination (jamais de fichier non vérifié dans front/).
fetch() {
  local url="$1" dest="$2" expected="$3" tmp actual
  tmp="$TMP_DL/$(basename "$dest")"
  curl -fsSL "$url" -o "$tmp"
  actual="$(sha256_of "$tmp")"
  if [ "$actual" != "$expected" ]; then
    echo "✗ SHA-256 inattendu pour $url" >&2
    echo "  attendu : $expected" >&2
    echo "  obtenu  : $actual" >&2
    exit 1
  fi
  mv -f "$tmp" "$dest"
}

echo "→ MSAL Browser 3.30.0..."
fetch "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.30.0/lib/msal-browser.min.js" \
  "$FRONT/msal-browser.min.js" \
  273d446b381814e563442267a072904fb3b7fd0164f4a688ede80f0d74565b3e

echo "→ Tabler Icons 3.19.0 (CSS + webfont)..."
mkdir -p "$FRONT/tabler-icons-webfont/fonts"
fetch "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css" \
  "$FRONT/tabler-icons-webfont/tabler-icons.min.css" \
  81be2d5bb248e144c143fce077b185a58d1d130109323d2925f092cef9fa8fb8
fetch "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/fonts/tabler-icons.woff2" \
  "$FRONT/tabler-icons-webfont/fonts/tabler-icons.woff2" \
  4f8d45c7d0faf9c7fec06e479a6870a567632b3f601b921156ca62316cfd795e
fetch "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/fonts/tabler-icons.woff" \
  "$FRONT/tabler-icons-webfont/fonts/tabler-icons.woff" \
  d7e73699371e663a9714e336cd7fb317e6e46551d83b193f05c25da9a36c6b98

echo "→ xterm.js 5.5.0 (terminal SSH dans la vue poste)..."
mkdir -p "$FRONT/styles"
fetch "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js" \
  "$FRONT/xterm.js" \
  1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495
fetch "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" \
  "$FRONT/styles/xterm.css" \
  ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6

echo "→ Chart.js 4.5.1 UMD (page Rapports)..."
fetch "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" \
  "$FRONT/chart.umd.min.js" \
  48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a

echo ""
echo "✓ Bibliothèques téléchargées et vérifiées dans $FRONT/"
