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

# ─── Clés agent-go (signature binaires + escrow LAPS) ───────────────────────
# docker-compose.example.yml monte ces fichiers : s'ils n'existent pas au
# premier `up`, Docker crée des RÉPERTOIRES à leur place, ce qui empoisonne
# toute génération ultérieure. On les génère donc ici si absents.
#
# Skippé hors checkout complet (ex : stage frontvendor du Dockerfile, qui ne
# copie que setup.sh + front/ et n'a pas openssl).
if [ ! -f agent-go/go.mod ] || ! command -v openssl >/dev/null 2>&1; then
  echo "→ Clés agent : skip (pas de checkout agent-go ou openssl absent)"
  exit 0
fi

KEYS=agent-go/keys
mkdir -p "$KEYS" agent-go/dist

for f in signing.key laps.key signing.pub laps.pub; do
  if [ -d "$KEYS/$f" ]; then
    echo "✗ $KEYS/$f est un répertoire (créé par un montage Docker avant la"
    echo "  génération des clés). Supprimez-le (rmdir $KEYS/$f) puis relancez."
    exit 1
  fi
done

if [ ! -f "$KEYS/signing.key" ]; then
  echo "→ Génération de la clé de signature agent (ed25519)..."
  openssl genpkey -algorithm ed25519 -out "$KEYS/signing.key"
  openssl pkey -in "$KEYS/signing.key" -pubout > "$KEYS/signing.pub"
  chmod 600 "$KEYS/signing.key"
fi

if [ ! -f "$KEYS/laps.key" ]; then
  echo "→ Génération de la clé d'escrow LAPS (RSA 4096)..."
  openssl genrsa -out "$KEYS/laps.key" 4096 2>/dev/null
  openssl rsa -in "$KEYS/laps.key" -pubout > "$KEYS/laps.pub" 2>/dev/null
  chmod 600 "$KEYS/laps.key"
fi

echo "✓ Clés agent présentes dans $KEYS/ (privées en mode 600 — à sauvegarder :"
echo "  perdre laps.key rend illisibles tous les mots de passe LAPS escrowés)"
echo ""
echo "Pensez à mettre à jour index.html pour pointer sur les fichiers locaux :"
echo "  <link rel=\"stylesheet\" href=\"/tabler-icons-webfont/tabler-icons.min.css\">"
echo "  (déjà fait pour msal-browser.min.js)"
