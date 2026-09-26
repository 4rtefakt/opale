// Garde « un seul tick à la fois » pour les workers périodiques.
//
// setInterval relance la fonction à heure fixe, que le tick précédent soit
// terminé ou non : un tick lent (Graph qui rame, gros lot) tourne alors en
// parallèle du suivant — doubles envois, curseurs qui reculent, syncs
// concurrentes.
//
// nonOverlapping(fn) renvoie une fonction `run` qui :
//   - lance fn si aucun tick n'est en cours, sinon ne fait rien (le tick
//     manqué est simplement sauté, le suivant arrivera à l'intervalle) ;
//   - ne rejette jamais : une erreur de fn est passée à onError (un tick ne
//     doit pas faire tomber le process via une rejection non gérée) ;
//   - expose run.idle() : promesse résolue quand le tick en cours (s'il y en
//     a un) est terminé — utilisé à l'arrêt pour ne pas couper un tick en
//     plein travail (ex. entre la réclamation et l'envoi d'un mail).
export function nonOverlapping(fn, { onError } = {}) {
  let running = null
  const run = () => {
    if (running) return running
    // .then(fn) : fn est toujours appelée de façon asynchrone, donc le
    // finally ne peut pas s'exécuter avant l'affectation de `running`.
    running = Promise.resolve()
      .then(fn)
      .catch((err) => { onError?.(err) })
      .finally(() => { running = null })
    return running
  }
  run.idle = () => running || Promise.resolve()
  return run
}
