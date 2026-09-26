// Taille de script_executions.output : VARCHAR(10000) depuis la migration
// 029 (minimisation RGPD). Toute sortie écrite dans la colonne doit être
// tronquée à cette taille, sinon l'UPDATE échoue (22001) et l'exécution
// reste 'running' : résultat de l'agent (/api/agent/result) et exécution
// SSH (routes/scripts.js).
export const SCRIPT_OUTPUT_MAX = 10000

// Sortie de script prête à être stockée : texte, sans octet NUL (refusé par
// Postgres, 22021 — sorties UTF-16 ou binaires de PowerShell / SSH), tronqué
// à SCRIPT_OUTPUT_MAX.
export function scriptOutputForDb(value) {
  return String(value ?? '').replaceAll('\u0000', '').slice(0, SCRIPT_OUTPUT_MAX)
}
