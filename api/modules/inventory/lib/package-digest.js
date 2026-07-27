// Empreinte du contenu exécutable d'un package.
//
// Le workflow d'approbation (draft → approved → deploy) suppose qu'un admin a
// relu ce qui va s'exécuter en SYSTEM sur le parc. Sans empreinte, ce lien est
// implicite et se rompt : le PATCH ne repassait en `draft` QUE si le package
// était déjà `approved`, donc une modification apportée pendant que le package
// est encore en `draft` — c'est-à-dire entre le moment où l'admin l'affiche et
// celui où il clique « Approuver » — passait sans laisser de trace. L'admin
// approuvait un contenu qu'il n'avait pas vu.
//
// L'empreinte matérialise le lien :
//   • à l'approbation, on fige le digest du contenu approuvé ;
//   • au déploiement, on recalcule et on compare — toute divergence bloque.
//
// Seuls les champs qui déterminent CE QUI S'EXÉCUTE entrent dans le calcul.
// Renommer un package ou corriger sa description ne doit pas invalider une
// approbation ; changer son install_script, si.

import crypto from 'node:crypto'

export const DIGESTED_FIELDS = [
  'type',
  'winget_id',
  'install_script',
  'post_install_script',
  'detection_script',
  'version',
]

/**
 * Digest stable du contenu exécutable d'un package.
 * `null` et `undefined` sont normalisés vers la chaîne vide pour qu'un champ
 * absent et un champ vide donnent la même empreinte (COALESCE côté SQL les
 * confond déjà).
 */
export function packageDigest(pkg = {}) {
  const h = crypto.createHash('sha256')
  for (const field of DIGESTED_FIELDS) {
    const value = pkg[field] ?? ''
    // Longueur préfixée : sans séparateur non ambigu, ('ab', 'c') et
    // ('a', 'bc') produiraient la même empreinte.
    h.update(`${field}:${String(value).length}:${value}\n`)
  }
  return h.digest('hex')
}
