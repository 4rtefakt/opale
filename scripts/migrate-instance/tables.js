// Catalog des tables à migrer entre deux instances Opale.
//
// L'ordre est IMPORTANT : il respecte les dépendances FK (parent avant enfant).
// `conflictTarget` est la clé naturelle utilisée pour ON CONFLICT (idempotence).
// `mode` :
//   - 'skip'   : DO NOTHING si la clé existe déjà (défaut, comportement attendu pour la migration)
//   - 'update' : DO UPDATE SET … = EXCLUDED.… pour préserver les valeurs custom de la source
//                (utilisé pour settings et automation_costs : leurs lignes sont seedées par
//                 les migrations sur le target avec valeurs par défaut neutres et doivent être
//                 écrasées par les valeurs de l'instance source).
// `selfRefColumn` : nom de la colonne FK auto-référentielle (insertée en NULL puis UPDATE en
//                   2e passe). Utilisé pour `agent_tokens.replaced_by`.
//
// Tables EXCLUES volontairement :
//   - schema_migrations : chaque instance gère son propre historique
//   - device_software   : régénéré par les agents au prochain checkin (cache)
//
// Note : `monitors` et `ticket_history` mentionnés dans certaines specs n'existent pas
// dans le schéma actuel — l'info "monitors" est dans devices.system_info (JSONB).

export const TABLES = [
  // === Layer 0 : pas de FK entrante ===
  // users_cache : mode 'update' pour que la source reste canonique sur
  // les champs sync Entra (notamment is_admin). Sinon, si une ligne a été
  // créée pré-migration côté target par un premier login, elle reste avec
  // les défauts (is_admin=false) — bug observé sur un cutover réel.
  { name: 'users_cache',         conflictTarget: ['entra_id'], mode: 'update' },
  { name: 'tags',                conflictTarget: ['name'] },
  { name: 'settings',            conflictTarget: ['key'],         mode: 'update' },
  { name: 'automation_costs',    conflictTarget: ['action_type'], mode: 'update' },
  { name: 'scripts',             conflictTarget: ['id'] },
  { name: 'stock_items',         conflictTarget: ['id'] },
  { name: 'onboardings',         conflictTarget: ['id'] },
  { name: 'audit_logs',          conflictTarget: ['id'] },
  { name: 'ssh_keys',            conflictTarget: ['id'] },
  { name: 'push_subscriptions',  conflictTarget: ['user_entra_id', 'endpoint'] },

  // === Layer 1 : FK → users_cache ===
  { name: 'devices',             conflictTarget: ['hostname'] },
  { name: 'packages',            conflictTarget: ['id'] },

  // === Layer 2 : FK → devices ===
  { name: 'disks',                     conflictTarget: ['id'] },
  { name: 'network_interfaces',        conflictTarget: ['id'] },
  { name: 'agent_tokens',              conflictTarget: ['token_hash'], selfRefColumn: 'replaced_by' },
  { name: 'tickets',                   conflictTarget: ['id'] },
  { name: 'alerts',                    conflictTarget: ['id'] },
  { name: 'script_executions',         conflictTarget: ['id'] },
  { name: 'stock_movements',           conflictTarget: ['id'] },
  { name: 'onboarding_checks',         conflictTarget: ['id'] },
  { name: 'remote_sessions',           conflictTarget: ['id'] },
  { name: 'deployments',               conflictTarget: ['id'] },
  { name: 'bandwidth_stats',           conflictTarget: ['id'] },
  { name: 'ping_stats',                conflictTarget: ['id'] },
  { name: 'system_perf_stats',         conflictTarget: ['id'] },
  { name: 'device_admin_credentials',  conflictTarget: ['device_id'] },
  { name: 'alert_snoozes',             conflictTarget: ['device_id', 'alert_type'] },

  // === Layer 3 : FK → tickets / tags ===
  { name: 'ticket_messages',           conflictTarget: ['id'] },
  { name: 'ticket_tags',               conflictTarget: ['ticket_id', 'tag_id'] },
  { name: 'ticket_proposals',          conflictTarget: ['id'] },
];

export const TABLE_NAMES = TABLES.map(t => t.name);

export function getTableConfig(name) {
  const cfg = TABLES.find(t => t.name === name);
  if (!cfg) throw new Error(`Unknown table: ${name}`);
  return cfg;
}
