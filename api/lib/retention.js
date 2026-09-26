// Durées de conservation (RGPD, cf. docs/PRIVACY.md §4.2) — SEULE source des
// constantes de rétention. La purge quotidienne (plugins/cleanup.js) et le
// nettoyage au fil de l'eau du checkin agent (séries temporelles du poste qui
// se présente) lisent ces valeurs : les deux ne peuvent plus diverger.
//
// Séries temporelles (bande passante, ping, perf) : 7 jours, soit la fenêtre
// maximale affichée par l'UI et la durée déjà appliquée par le checkin. La
// purge quotidienne couvre en plus les postes qui ne font plus de checkin.
//
// remote_session_logs (30 j) plus court que remote_sessions (183 j) : les
// frames raw contiennent le contenu intégral du terminal (mots de passe
// affichés, données users) — sensibilité bien plus haute que les
// métadonnées de session. La FK ON DELETE CASCADE garantit en plus que le
// log suit si la session parente est purgée.
export const RETENTION_RULES = [
  { table: 'bandwidth_stats',      col: 'sampled_at', days: 7   },
  { table: 'ping_stats',           col: 'sampled_at', days: 7   },
  { table: 'system_perf_stats',    col: 'sampled_at', days: 7   },
  { table: 'remote_session_logs',  col: 'created_at', days: 30  },
  { table: 'remote_sessions',      col: 'started_at', days: 183 },
  { table: 'audit_logs',           col: 'created_at', days: 365 },
  { table: 'script_executions',    col: 'started_at', days: 90  },
]

export function retentionDays(table) {
  const rule = RETENTION_RULES.find(r => r.table === table)
  if (!rule) throw new Error(`Rétention inconnue pour la table ${table}`)
  return rule.days
}
