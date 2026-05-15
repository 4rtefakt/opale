#!/usr/bin/env bash
# Génère UN seul installer Intune avec mapping hostname→token embarqué.
#
# Différence avec bulk-build-intune-installers.sh (qui produit 1 installer par PC) :
# ici on produit UN script qui contient les tokens de N PCs. Au runtime, le PC
# pioche son token via $env:COMPUTERNAME et télécharge le binaire Go depuis
# l'API. Avantage : 1 upload Intune, 1 assignation à un groupe.
#
# Pour chaque hostname :
#   1. Récupère son device_id depuis la DB
#   2. Génère un token unique
#   3. INSERT le SHA256 dans agent_tokens (lié au device_id)
#   4. Ajoute hostname→token au mapping embarqué
#
# Sortie : intune-installers/install-bulk-YYYY-MM-DD.ps1
#
# Sécurité : le script Intune contient N tokens en clair. Risque limité car :
#   - exécuté en SYSTEM (jamais accessible aux users)
#   - stocké côté Microsoft Intune (chiffré, ACL admin tenant)
#   - téléchargé en HTTPS sur le PC, exécuté immédiatement, non persisté
# Pour 16-100 PCs c'est acceptable. Au-delà, envisager un endpoint bootstrap
# avec auth device-attested (Entra device certificate).

#
# Variables d'environnement (toutes requises sauf OUTPUT_DIR/LABEL_PREFIX) :
#   URL              URL publique du serveur RMM (ex: https://rmm.example.com)
#   SSH_HOST         user@host pour ssh vers le serveur de prod
#   DB_USER          user PostgreSQL
#   DB_NAME          nom de la DB
#   REMOTE_APP_PATH  chemin du docker-compose côté serveur (ex: /opt/apps/opale)
#   OUTPUT_DIR       dossier de sortie (défaut : ./intune-installers, gitignored)
#   LABEL_PREFIX     défaut : intune-bulk-YYYY-MM-DD

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

  hostnames-file : un hostname par ligne (lignes vides et # ignorés)

Variables :
  URL          = $URL
  SSH_HOST     = $SSH_HOST
  OUTPUT_DIR   = $OUTPUT_DIR
  LABEL_PREFIX = $LABEL_PREFIX

Sortie :
  \$OUTPUT_DIR/install-bulk-YYYY-MM-DD.ps1
  \$OUTPUT_DIR/manifest-bulk-YYYY-MM-DD.csv
USAGE
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TEMPLATE="$REPO_ROOT/agent-go/install-bulk-template.ps1"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERREUR : template introuvable : $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
DATE_TAG=$(date +%Y-%m-%d)
OUT_SCRIPT="$OUTPUT_DIR/install-bulk-${DATE_TAG}.ps1"
OUT_MANIFEST="$OUTPUT_DIR/manifest-bulk-${DATE_TAG}.csv"
TOKENS_TMP=$(mktemp -t opale-tokens.XXXXXX)
trap 'rm -f "$TOKENS_TMP"' EXIT
echo "hostname,device_id,token_prefix,generated_at" > "$OUT_MANIFEST"

mapfile -t HOSTS < <(grep -vE '^\s*(#|$)' "$HOSTNAMES_FILE" | tr -d '[:space:]\r' | grep -v '^$' | sort -u)
if [[ ${#HOSTS[@]} -eq 0 ]]; then
  echo "Aucun hostname valide dans $HOSTNAMES_FILE" >&2
  exit 1
fi

echo "→ ${#HOSTS[@]} hostnames à traiter"
echo ""

COUNT_OK=0
COUNT_SKIP=0
: > "$TOKENS_TMP"  # tronque le fichier temp

for HOSTNAME in "${HOSTS[@]}"; do
  DEVICE_ID=$(ssh -o BatchMode=yes "$SSH_HOST" \
    "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -t -A -c \"SELECT id FROM devices WHERE hostname='$HOSTNAME';\"" \
    | tr -d '[:space:]')

  if [[ -z "$DEVICE_ID" ]]; then
    echo "  [$HOSTNAME] ⚠ device introuvable en DB, skip"
    COUNT_SKIP=$((COUNT_SKIP+1))
    continue
  fi

  TOKEN=$(openssl rand -hex 32)
  HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
  LABEL="${LABEL_PREFIX}-${HOSTNAME}"

  ssh -o BatchMode=yes "$SSH_HOST" \
    "cd $REMOTE_APP_PATH && docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c \"INSERT INTO agent_tokens (label, token_hash, device_id) VALUES ('$LABEL', '$HASH', '$DEVICE_ID');\"" \
    > /dev/null

  printf "    '%s' = '%s'\n" "$HOSTNAME" "$TOKEN" >> "$TOKENS_TMP"

  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "${HOSTNAME},${DEVICE_ID},${TOKEN:0:12}...,${TS}" >> "$OUT_MANIFEST"
  echo "  [$HOSTNAME] ✓ device=${DEVICE_ID:0:8}... token=${TOKEN:0:8}..."
  COUNT_OK=$((COUNT_OK+1))
done

if [[ $COUNT_OK -eq 0 ]]; then
  echo ""
  echo "ERREUR : aucun PC traité avec succès. Pas de script généré." >&2
  rm -f "$OUT_MANIFEST"
  exit 1
fi

# Substitution dans le template :
#   - ##URL##         → remplacé inline par sed
#   - ##TOKENS_MAP##  → remplacé par le contenu de $TOKENS_TMP via sed `r`
# (sed `r` insère après la ligne, `d` supprime la ligne placeholder)
sed -e "s|##URL##|$URL|g" \
    -e "/##TOKENS_MAP##/{
        r $TOKENS_TMP
        d
    }" \
    "$TEMPLATE" > "$OUT_SCRIPT"

echo ""
echo "✓ Installer bulk généré : $OUT_SCRIPT ($(wc -c < "$OUT_SCRIPT") octets)"
echo "✓ Manifest             : $OUT_MANIFEST"
echo "✓ ${COUNT_OK} PC(s) couverts, ${COUNT_SKIP} skip(s)"
echo ""
echo "Étape suivante : uploader $OUT_SCRIPT dans Intune (1 seul script,"
echo "assignation à un groupe statique ou dynamique 'PCs sans agent Go')."
echo "Le script s'auto-skip pour les PCs hors mapping (pas d'erreur Intune)."
