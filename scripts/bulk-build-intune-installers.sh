#!/usr/bin/env bash
# Génère un install-Agent.ps1 par hostname pour déploiement Intune device-targeted.
#
# Pour chaque PC :
#   1. Récupère son device_id depuis la DB de prod
#   2. Génère un token unique (32 bytes hex)
#   3. INSERT le token (SHA256) dans agent_tokens, lié à device_id
#   4. Build agent-go/dist/install-Agent.ps1 avec ce token + URL embarqués
#   5. Copie dans <OUTPUT_DIR>/install-<HOSTNAME>.ps1
#
# Pas d'endpoint serveur exposé : tout est généré côté admin, le binaire et le
# token voyagent ensuite via le canal authentifié Intune.
#
# Usage :
#   ./scripts/bulk-build-intune-installers.sh hostnames.txt
#
# Variables d'environnement (toutes requises sauf OUTPUT_DIR/LABEL_PREFIX) :
#   URL              URL publique du serveur RMM (ex: https://rmm.example.com)
#   SSH_HOST         user@host pour ssh vers le serveur de prod
#   DB_USER          user PostgreSQL
#   DB_NAME          nom de la DB
#   REMOTE_APP_PATH  chemin du docker-compose côté serveur (ex: /opt/apps/opale)
#   OUTPUT_DIR       dossier de sortie (défaut : ./intune-installers, gitignored)
#   LABEL_PREFIX     défaut : intune-bulk-YYYY-MM-DD
#
# Pratique : sourcer un fichier env perso (ex: ~/.opale-build.env) avant l'appel.
#
# Pré-requis :
#   - openssl, shasum, ssh sur la machine locale
#   - Go installé (1.21+) pour le premier build
#   - node 20+ pour agent-go/build.js
#   - Accès SSH root au serveur de prod

set -euo pipefail

: "${URL:?URL non défini (ex: URL=https://rmm.example.com)}"
: "${SSH_HOST:?SSH_HOST non défini (ex: SSH_HOST=root@host.example.com)}"
: "${DB_USER:?DB_USER non défini (ex: DB_USER=opale)}"
: "${DB_NAME:?DB_NAME non défini (ex: DB_NAME=opale)}"
: "${REMOTE_APP_PATH:?REMOTE_APP_PATH non défini (ex: REMOTE_APP_PATH=/opt/apps/opale)}"

HOSTNAMES_FILE="${1:-}"
OUTPUT_DIR="${OUTPUT_DIR:-./intune-installers}"
LABEL_PREFIX="${LABEL_PREFIX:-intune-bulk-$(date +%Y-%m-%d)}"

if [[ -z "$HOSTNAMES_FILE" || ! -f "$HOSTNAMES_FILE" ]]; then
  cat <<USAGE >&2
Usage: $0 <hostnames-file>

  hostnames-file : un hostname par ligne (lignes vides et commentaires # ignorés)

Variables d'environnement :
  URL          = $URL
  SSH_HOST     = $SSH_HOST
  DB_USER      = $DB_USER
  DB_NAME      = $DB_NAME
  OUTPUT_DIR   = $OUTPUT_DIR
  LABEL_PREFIX = $LABEL_PREFIX

Exemple :
  echo -e "DESKTOP-FOO\nDESKTOP-BAR" > /tmp/hosts.txt
  $0 /tmp/hosts.txt

Le manifest CSV (hostname,device_id,token_prefix,installer_path) est écrit
dans \$OUTPUT_DIR/manifest.csv pour audit.
USAGE
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p "$OUTPUT_DIR"
MANIFEST="$OUTPUT_DIR/manifest.csv"
echo "hostname,device_id,token_prefix,installer_path,generated_at" > "$MANIFEST"

# Lecture défensive des hostnames : on supprime espaces, on saute lignes vides
# et commentaires.
mapfile -t HOSTS < <(grep -vE '^\s*(#|$)' "$HOSTNAMES_FILE" | tr -d '[:space:]\r' | grep -v '^$' | sort -u)

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  echo "Aucun hostname valide dans $HOSTNAMES_FILE" >&2
  exit 1
fi

echo "→ ${#HOSTS[@]} hostnames à traiter (sortie : $OUTPUT_DIR)"
echo ""

FIRST=1
COUNT_OK=0
COUNT_SKIP=0

for HOSTNAME in "${HOSTS[@]}"; do
  # 1. device_id depuis la DB
  DEVICE_ID=$(ssh -o BatchMode=yes "$SSH_HOST" \
    "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -t -A -c \"SELECT id FROM devices WHERE hostname='$HOSTNAME';\"" \
    | tr -d '[:space:]')

  if [[ -z "$DEVICE_ID" ]]; then
    echo "  [$HOSTNAME] ⚠ device introuvable en DB, skip"
    COUNT_SKIP=$((COUNT_SKIP+1))
    continue
  fi

  # 2. Token + INSERT en DB (SHA256 hash, le token clair n'est jamais stocké)
  TOKEN=$(openssl rand -hex 32)
  HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
  LABEL="${LABEL_PREFIX}-${HOSTNAME}"

  ssh -o BatchMode=yes "$SSH_HOST" \
    "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \"INSERT INTO agent_tokens (label, token_hash, device_id) VALUES ('$LABEL', '$HASH', '$DEVICE_ID');\"" \
    > /dev/null

  # 3. Build installer (premier appel = compile Go ; suivants : --no-build)
  if [[ "$FIRST" == "1" ]]; then
    TOKEN="$TOKEN" URL="$URL" node agent-go/build.js > /dev/null
    FIRST=0
  else
    TOKEN="$TOKEN" URL="$URL" node agent-go/build.js --no-build > /dev/null
  fi

  # 4. Copy vers sortie nominative
  OUT_PATH="$OUTPUT_DIR/install-${HOSTNAME}.ps1"
  cp agent-go/dist/install-Agent.ps1 "$OUT_PATH"

  # 5. Manifest
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "${HOSTNAME},${DEVICE_ID},${TOKEN:0:12}...,${OUT_PATH},${TS}" >> "$MANIFEST"

  echo "  [$HOSTNAME] ✓ device=${DEVICE_ID:0:8}... token=${TOKEN:0:8}... → $OUT_PATH"
  COUNT_OK=$((COUNT_OK+1))
done

echo ""
echo "Terminé : $COUNT_OK installer(s) générés, $COUNT_SKIP skip(s)"
echo "Manifest : $MANIFEST"
echo ""
echo "Étape suivante : pousser via Intune en assignation device-targeted"
echo "(1 script Intune par PC, ciblé sur le device Entra correspondant)."
