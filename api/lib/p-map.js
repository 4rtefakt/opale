// Exécution concurrente bornée.
//
// `Promise.all(items.map(fn))` lance TOUT en même temps. Sur les chemins qui
// ouvrent une connexion sortante par élément — exécution de script SSH sur un
// groupe, redémarrage d'agent en masse — cela veut dire autant de sockets
// simultanés que de postes ciblés. Sur un groupe de 200 machines, le process
// API ouvre 200 connexions SSH d'un coup, sature ses descripteurs de fichiers
// et son pool Postgres, et dégrade tout le reste de l'application pendant ce
// temps.
//
// pMap borne le nombre d'exécutions simultanées tout en traitant la totalité
// des éléments. Les résultats sont retournés dans l'ordre des entrées, pas
// dans l'ordre d'achèvement.
//
// Volontairement sans dépendance : quinze lignes valent mieux qu'un paquet npm
// de plus dans un produit qui manipule des clés SSH.

export const DEFAULT_CONCURRENCY = 10

/**
 * @param {Array}    items
 * @param {Function} fn          - (item, index) => Promise
 * @param {number}   concurrency - nombre maximum d'exécutions simultanées
 * @returns {Promise<Array>} résultats dans l'ordre des entrées
 */
export async function pMap(items, fn, concurrency = DEFAULT_CONCURRENCY) {
  const list = Array.from(items)
  const results = new Array(list.length)
  const limit = Math.max(1, Math.min(concurrency, list.length))
  let next = 0

  async function worker() {
    while (true) {
      const i = next++
      if (i >= list.length) return
      results[i] = await fn(list[i], i)
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
