// Nettoyage des données d'un mail avant écriture en base.
//
// Postgres refuse l'octet 0x00 dans un TEXT (« invalid byte sequence for
// encoding "UTF8": 0x00 ») et la séquence \u0000 dans un JSONB. Un mail
// externe qui en contient (sujet, expéditeur, corps…) échouerait donc à
// chaque tentative : n'importe quel expéditeur pourrait fabriquer un mail
// « poison » qui bloque la boîte. On retire ces caractères, récursivement
// (clés comprises), sur une copie.

export function stripNul(value) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value
  if (Array.isArray(value)) return value.map(stripNul)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripNul(k), stripNul(v)]))
  }
  return value
}
