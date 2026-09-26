// Taille de script_executions.output : VARCHAR(10000) depuis la migration
// 029 (minimisation RGPD). Toute sortie écrite dans la colonne doit être
// tronquée à cette taille, sinon l'UPDATE échoue (22001) et l'exécution
// reste 'running' : résultat de l'agent (/api/agent/result) et exécution
// SSH (routes/scripts.js).
export const SCRIPT_OUTPUT_MAX = 10000
