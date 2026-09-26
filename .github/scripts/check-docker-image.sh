#!/usr/bin/env bash
# Opale — vérifications runtime d'une image API déjà construite et chargée
# dans le démon Docker local (appelé par .github/workflows/ci.yml pour
# l'image tout-en-un et pour l'image api/Dockerfile).
#
# Usage : .github/scripts/check-docker-image.sh <image>
set -euo pipefail

image="${1:?usage: $0 <image>}"

# ─── Dépendances = lockfile ─────────────────────────────────────────────────
# L'image doit installer exactement les versions de api/package-lock.json
# (`npm ci`), celles que la suite de tests a validées — pas une résolution
# libre des plages semver au moment du build (`npm install` sans lockfile).
echo "→ node_modules conforme à package-lock.json"
docker run --rm -i "$image" node - <<'JS'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
let checked = 0, bad = 0
for (const [p, meta] of Object.entries(lock.packages)) {
  // Paquets optionnels (ex. cpu-features, natif) : absents si leur build échoue.
  if (!p.startsWith('node_modules/') || meta.dev || meta.optional || meta.devOptional) continue
  checked++
  let v = null
  try { v = JSON.parse(fs.readFileSync(p + '/package.json', 'utf8')).version } catch {}
  if (v !== meta.version) { bad++; console.log(`::error::${p} : installé ${v}, lockfile ${meta.version}`) }
}
console.log(`${checked} paquets vérifiés, ${bad} écart(s) avec package-lock.json`)
process.exit(bad || !checked ? 1 : 0)
JS

# ─── Version de Node ────────────────────────────────────────────────────────
# Même majeure que la CI et que `engines` (Node 20 est en fin de vie).
echo "→ Node 22"
major=$(docker run --rm "$image" node -p 'process.versions.node.split(".")[0]')
if [ "$major" != 22 ]; then
  echo "::error::l'image embarque Node $major (attendu 22)"
  exit 1
fi

# ─── Utilisateur non-root ───────────────────────────────────────────────────
echo "→ process non-root (node, uid 1000)"
uid=$(docker run --rm "$image" id -u)
if [ "$uid" != 1000 ]; then
  echo "::error::l'image tourne en uid $uid (attendu 1000 = node)"
  exit 1
fi

# Le code de l'application reste à root : le process ne peut pas le modifier.
echo "→ /app en lecture seule pour le process"
if docker run --rm "$image" touch /app/index.js 2>/dev/null; then
  echo "::error::/app/index.js est modifiable par l'utilisateur du process"
  exit 1
fi

# Pièces jointes (seul chemin écrit au runtime) : inscriptibles dans l'image
# ET dans un volume nommé neuf, qui hérite du propriétaire du dossier de
# l'image au premier montage (cas docker compose).
echo "→ pièces jointes inscriptibles (image, puis volume nommé neuf)"
# shellcheck disable=SC2016  # $d est expansé par le sh du conteneur.
write_test='d=/app/data/ticket-attachments; mkdir "$d/ci" && echo ok > "$d/ci/f" && rm -r "$d/ci"'
docker run --rm "$image" sh -c "$write_test"
vol="opale-ci-attachments-$$"
docker volume create "$vol" >/dev/null
trap 'docker volume rm -f "$vol" >/dev/null 2>&1 || true' EXIT
docker run --rm -v "$vol:/app/data/ticket-attachments" "$image" sh -c "$write_test"

echo "OK: $image"
