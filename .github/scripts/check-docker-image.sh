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

echo "OK: $image"
