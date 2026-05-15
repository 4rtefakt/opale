#!/usr/bin/env bash
# Génère UN script Intune avec un bootstrap token unique embarqué.
#
# Le script peut être assigné à TOUS les Windows (groupe statique ou dynamique)
# sans configuration par PC. Au runtime, chaque PC échange le bootstrap contre
# un token perso device-lié via POST /api/agent/exchange-token.
#
# Pattern setup-key Tailscale/Netbird. Le bootstrap est révocable et expire
# automatiquement (par défaut 7 jours).
#
# Usage :
#   ./scripts/build-intune-bootstrap.sh [duration_days]
#
# Arguments :
#   duration_days : durée de validité du bootstrap (défaut : 7)
#
# Variables d'environnement (toutes requises sauf OUTPUT_DIR/LABEL) :
#   URL              URL publique du serveur RMM (ex: https://rmm.example.com)
#   SSH_HOST         user@host pour ssh vers le serveur de prod
#   DB_USER          user PostgreSQL
#   DB_NAME          nom de la DB
#   REMOTE_APP_PATH  chemin du docker-compose côté serveur (ex: /opt/apps/opale)
#   OUTPUT_DIR       dossier de sortie (défaut : ./intune-installers, gitignored)
#   LABEL            défaut : bootstrap-YYYY-MM-DD
#
# Pratique : sourcer un fichier env perso (ex: ~/.opale-build.env) avant l'appel :
#   export URL=https://rmm.example.com
#   export SSH_HOST=root@host.example.com
#   export DB_USER=opale  DB_NAME=opale  REMOTE_APP_PATH=/opt/apps/opale
#
# Sortie :
#   $OUTPUT_DIR/install-bootstrap-YYYY-MM-DD.ps1  (gitignored, ~6 KB)
#   $OUTPUT_DIR/bootstrap-YYYY-MM-DD.info.txt     (audit : token clair, expiry)

set -euo pipefail

: "${URL:?URL non défini (ex: URL=https://rmm.example.com)}"
: "${SSH_HOST:?SSH_HOST non défini (ex: SSH_HOST=root@host.example.com)}"
: "${DB_USER:?DB_USER non défini (ex: DB_USER=opale)}"
: "${DB_NAME:?DB_NAME non défini (ex: DB_NAME=opale)}"
: "${REMOTE_APP_PATH:?REMOTE_APP_PATH non défini (ex: REMOTE_APP_PATH=/opt/apps/opale)}"

DURATION_DAYS="${1:-7}"
OUTPUT_DIR="${OUTPUT_DIR:-./intune-installers}"
DATE_TAG=$(date +%Y-%m-%d)
LABEL="${LABEL:-bootstrap-${DATE_TAG}}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TEMPLATE="$REPO_ROOT/agent-go/install-bootstrap-template.ps1"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERREUR : template introuvable : $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUT_SCRIPT="$OUTPUT_DIR/install-bootstrap-${DATE_TAG}.ps1"
OUT_INFO="$OUTPUT_DIR/bootstrap-${DATE_TAG}.info.txt"

# 1. Génère un bootstrap token + INSERT en DB avec is_bootstrap=true et expires_at
TOKEN=$(openssl rand -hex 32)
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

ssh -o BatchMode=yes "$SSH_HOST" \
  "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \"INSERT INTO agent_tokens (label, token_hash, is_bootstrap, expires_at, created_by) VALUES ('$LABEL', '$HASH', TRUE, now() + INTERVAL '$DURATION_DAYS days', 'build-intune-bootstrap.sh');\"" \
  > /dev/null

echo "→ Bootstrap token créé : label=$LABEL  expires=now+${DURATION_DAYS}d"

# 2. Lire le profil de branding depuis instance-local/agent-profile.json
#    (défauts neutres "Opale" si absent — cf. agent-go/build.js)
read_profile_field() {
  local field="$1" default="$2"
  local profile="$REPO_ROOT/instance-local/agent-profile.json"
  if [[ -f "$profile" ]]; then
    python3 -c "import json,sys; p=json.load(open('$profile')); print(p.get('$field', '$default'))" 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}
SERVICE_NAME=$(read_profile_field serviceName 'Opale-Agent')
DATA_DIR_NAME=$(read_profile_field dataDirName 'Opale')
BIN_NAME=$(read_profile_field binName 'opale-agent')
LEGACY_SCHTASKS_NAME=$(read_profile_field legacySchtasksName '')

# 3. Substitution dans le template
sed -e "s|##URL##|$URL|g" \
    -e "s|##BOOTSTRAP_TOKEN##|$TOKEN|g" \
    -e "s|##SERVICE_NAME##|$SERVICE_NAME|g" \
    -e "s|##DATA_DIR_NAME##|$DATA_DIR_NAME|g" \
    -e "s|##BIN_NAME##|$BIN_NAME|g" \
    -e "s|##LEGACY_SCHTASKS_NAME##|$LEGACY_SCHTASKS_NAME|g" \
    "$TEMPLATE" > "$OUT_SCRIPT"

# 3. Info file (audit, JAMAIS à committer)
cat > "$OUT_INFO" <<INFO
# Bootstrap token info — généré $(date -u +%Y-%m-%dT%H:%M:%SZ)
LABEL=$LABEL
TOKEN=$TOKEN
URL=$URL
EXPIRES=now+${DURATION_DAYS}d
INTUNE_SCRIPT=$OUT_SCRIPT

# Pour révoquer manuellement avant expiry :
ssh $SSH_HOST "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \"UPDATE agent_tokens SET revoked_at = now() WHERE label = '$LABEL';\""

# Pour voir combien de PCs l'ont utilisé :
ssh $SSH_HOST "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \"SELECT label, bootstrap_redeemed_count, bootstrap_redeemed_at, expires_at FROM agent_tokens WHERE label = '$LABEL';\""
INFO

echo ""
echo "✓ Script Intune  : $OUT_SCRIPT ($(wc -c < "$OUT_SCRIPT") octets)"
echo "✓ Info bootstrap : $OUT_INFO"
echo ""
echo "Étape suivante : uploader $OUT_SCRIPT dans Intune (Platform Scripts)"
echo "Assignation : groupe Entra (statique ou dynamique 'Windows + agent_version is null')"
echo "Le script s'auto-skip pour les PCs où l'agent Go tourne déjà."
echo ""
echo "Surveillance :"
echo "  ssh $SSH_HOST \"cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \\\"SELECT bootstrap_redeemed_count FROM agent_tokens WHERE label = '$LABEL';\\\"\""
