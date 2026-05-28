// Ask Opale — registre des ressources interrogeables.
//
// SOURCE DE VÉRITÉ de la feature. Le LLM ne génère jamais de SQL : il produit
// un QuerySpec (cf. queryspec.js) dont chaque champ est validé contre ce
// registre, puis compilé en SQL paramétré (cf. compile.js). Toute la
// construction d'identifiants SQL (tables, colonnes) vient d'ICI — jamais de
// l'input utilisateur/LLM. Seules les *valeurs* transitent en paramètres ($n).
// Conséquence : pas d'injection possible par construction.
//
// Forme d'un filtre :
//   {
//     type   : 'enum' | 'text' | 'number' | 'bool' | 'resolve',
//     enum   : [...]            // requis si type='enum'
//     resolve: 'group'|'user'|'department'|'tag'|'rule'  // requis si type='resolve'
//     desc   : libellé court FR — sert à la fois la doc et le prompt LLM,
//     apply(value, ctx) : (value validée + résolue) → fragment SQL. ctx.param(v)
//                         enregistre v comme paramètre et retourne son '$n'.
//                         ctx.opts donne accès aux options de compilation
//                         (ex: seuils disque settings).
//   }
//
// Les `crossFilters` suivent la même forme mais produisent une clause EXISTS
// (relationnel). C'est le mécanisme — volontairement réservé — pour les
// requêtes croisées (device↔ticket, device↔compliance, device↔group) sans
// ouvrir des jointures arbitraires. On élargit la *liste*, jamais le *shape*.

import { RULES } from '../../monitoring/lib/compliance.js'

const RULE_IDS = RULES.map(r => r.id)

// Seuils disque par défaut — alignés sur computeStatus() de la fiche poste.
// La compilation peut les surcharger via opts.thresholds (lus depuis settings).
const DEFAULT_THRESHOLDS = { warn: 80, critical: 90 }

function thr(ctx) {
  return { ...DEFAULT_THRESHOLDS, ...(ctx.opts?.thresholds || {}) }
}

// ── DEVICES ──────────────────────────────────────────────────────────────
const devices = {
  table: 'devices d',
  joins: ['LEFT JOIN users_cache u ON d.assigned_user_id = u.entra_id'],
  select: `
    d.id, d.hostname, d.serial, d.model, d.manufacturer, d.os, d.os_build,
    d.disk_used_pct, d.ram_gb, d.ip_netbird, d.agent_version, d.last_seen,
    d.compliance_state,
    u.entra_id AS user_id, u.display_name AS user_name, u.email AS user_email,
    u.department AS user_department`,
  sort: {
    hostname:      'd.hostname',
    last_seen:     'd.last_seen',
    disk_used_pct: 'd.disk_used_pct',
    ram_gb:        'd.ram_gb',
    created_at:    'd.created_at',
  },
  defaultSort: { field: 'hostname', dir: 'asc' },
  defaultLimit: 100,
  maxLimit: 500,

  filters: {
    status: {
      type: 'enum', enum: ['online', 'offline', 'critical', 'warn', 'unassigned'],
      desc: 'état du poste',
      apply: (v, ctx) => {
        const t = thr(ctx)
        switch (v) {
          case 'online':     return `d.last_seen > now() - interval '1 hour'`
          case 'offline':    return `(d.last_seen IS NULL OR d.last_seen < now() - interval '1 hour')`
          case 'critical':   return `d.disk_used_pct >= ${t.critical}`
          case 'warn':       return `d.disk_used_pct >= ${t.warn} AND d.disk_used_pct < ${t.critical}`
          case 'unassigned': return `d.assigned_user_id IS NULL`
        }
      },
    },
    search: {
      type: 'text', desc: 'recherche libre (hostname, utilisateur, modèle)',
      apply: (v, ctx) => {
        const p = ctx.param(`%${v}%`)
        return `(d.hostname ILIKE ${p} OR u.email ILIKE ${p} OR u.display_name ILIKE ${p} OR d.model ILIKE ${p})`
      },
    },
    hostname_contains: {
      type: 'text', desc: 'le hostname contient',
      apply: (v, ctx) => `d.hostname ILIKE ${ctx.param(`%${v}%`)}`,
    },
    os_contains: {
      type: 'text', desc: "le système d'exploitation contient (ex: 'Windows 11')",
      apply: (v, ctx) => `d.os ILIKE ${ctx.param(`%${v}%`)}`,
    },
    model_contains: {
      type: 'text', desc: 'le modèle contient',
      apply: (v, ctx) => `d.model ILIKE ${ctx.param(`%${v}%`)}`,
    },
    manufacturer: {
      type: 'text', desc: 'fabricant exact',
      apply: (v, ctx) => `d.manufacturer ILIKE ${ctx.param(v)}`,
    },
    disk_used_pct_gte: {
      type: 'number', desc: 'disque utilisé ≥ (pourcentage)',
      apply: (v, ctx) => `d.disk_used_pct >= ${ctx.param(v)}`,
    },
    disk_used_pct_lt: {
      type: 'number', desc: 'disque utilisé < (pourcentage)',
      apply: (v, ctx) => `d.disk_used_pct < ${ctx.param(v)}`,
    },
    ram_gb_lt: {
      type: 'number', desc: 'RAM (Go) <',
      apply: (v, ctx) => `d.ram_gb < ${ctx.param(v)}`,
    },
    offline_since_days: {
      type: 'number', desc: "pas vu depuis au moins N jours (offline prolongé)",
      apply: (v, ctx) => `(d.last_seen IS NULL OR d.last_seen < now() - make_interval(days => ${ctx.param(v)}))`,
    },
    seen_within_days: {
      type: 'number', desc: 'vu au cours des N derniers jours',
      apply: (v, ctx) => `d.last_seen > now() - make_interval(days => ${ctx.param(v)})`,
    },
    assigned: {
      type: 'bool', desc: 'a un utilisateur assigné (true) ou non (false)',
      apply: (v) => v ? `d.assigned_user_id IS NOT NULL` : `d.assigned_user_id IS NULL`,
    },
    has_agent: {
      type: 'bool', desc: "l'agent Opale est installé (true) ou non (false)",
      apply: (v) => v ? `d.agent_version IS NOT NULL` : `d.agent_version IS NULL`,
    },
    pending_reboot: {
      type: 'bool', desc: 'redémarrage en attente',
      apply: (v, ctx) => `(d.health_signals->>'pending_reboot')::bool = ${ctx.param(v)}`,
    },
    bitlocker_active: {
      type: 'bool', desc: 'BitLocker actif sur C:',
      apply: (v) => {
        const cond = `d.health_signals->'bitlocker'->>'protection_status' = 'on'`
        return v ? cond : `NOT (${cond})`
      },
    },
    department: {
      type: 'resolve', resolve: 'department', desc: "département de l'utilisateur assigné",
      apply: (v, ctx) => `u.department = ${ctx.param(v)}`,
    },
    assigned_user: {
      type: 'resolve', resolve: 'user', desc: 'assigné à un utilisateur (nom ou email)',
      apply: (v, ctx) => `d.assigned_user_id = ${ctx.param(v)}`,
    },
  },

  crossFilters: {
    // device ↔ ticket : postes concernés par un ticket (filtrable par statut/priorité).
    has_ticket: {
      type: 'enum',
      enum: ['any', 'open', 'critical', 'high'],
      desc: 'a un ticket lié (any|open|critical|high)',
      apply: (v, ctx) => {
        const extra = v === 'open'
          ? ` AND t.status NOT IN ('resolved','closed','merged')`
          : v === 'critical'
            ? ` AND t.priority = 'critical' AND t.status NOT IN ('resolved','closed','merged')`
            : v === 'high'
              ? ` AND t.priority = 'high' AND t.status NOT IN ('resolved','closed','merged')`
              : ''
        return `EXISTS (SELECT 1 FROM ticket_devices td JOIN tickets t ON t.id = td.ticket_id WHERE td.device_id = d.id${extra})`
      },
    },
    // device ↔ compliance : poste en échec sur une règle donnée.
    failing_rule: {
      type: 'enum', enum: RULE_IDS, desc: 'en échec sur une règle de conformité',
      apply: (v, ctx) =>
        `EXISTS (SELECT 1 FROM compliance_results cr WHERE cr.device_id = d.id AND cr.rule_id = ${ctx.param(v)} AND cr.status = 'fail')`,
    },
    // device ↔ group : appartient à un groupe (résolu nom → id).
    in_group: {
      type: 'resolve', resolve: 'group', desc: 'appartient à un groupe',
      apply: (v, ctx) =>
        `EXISTS (SELECT 1 FROM group_members gm WHERE gm.device_id = d.id AND gm.group_id = ${ctx.param(v)})`,
    },
  },
}

// ── TICKETS ──────────────────────────────────────────────────────────────
const tickets = {
  table: 'tickets t',
  joins: [
    'LEFT JOIN users_cache u ON t.user_id = u.entra_id',
    'LEFT JOIN devices d ON t.device_id = d.id',
  ],
  select: `
    t.id, t.title, t.status, t.priority, t.is_auto,
    t.created_at, t.updated_at, t.resolved_at,
    u.display_name AS requester_name, u.email AS requester_email,
    d.hostname AS device_hostname`,
  sort: {
    created_at:  't.created_at',
    updated_at:  't.updated_at',
    resolved_at: 't.resolved_at',
    priority:    `CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
  },
  defaultSort: { field: 'created_at', dir: 'desc' },
  defaultLimit: 100,
  maxLimit: 500,

  filters: {
    status: {
      type: 'enum', enum: ['open', 'in_progress', 'resolved', 'closed', 'merged'],
      desc: 'statut du ticket',
      apply: (v, ctx) => `t.status = ${ctx.param(v)}`,
    },
    is_open: {
      type: 'bool', desc: 'ouvert/en cours (true) ou clos (false)',
      apply: (v) => v
        ? `t.status NOT IN ('resolved','closed','merged')`
        : `t.status IN ('resolved','closed','merged')`,
    },
    priority: {
      type: 'enum', enum: ['low', 'normal', 'high', 'critical'], desc: 'priorité',
      apply: (v, ctx) => `t.priority = ${ctx.param(v)}`,
    },
    title_contains: {
      type: 'text', desc: 'le titre contient',
      apply: (v, ctx) => `t.title ILIKE ${ctx.param(`%${v}%`)}`,
    },
    is_auto: {
      type: 'bool', desc: 'créé automatiquement (true) ou manuellement (false)',
      apply: (v, ctx) => `t.is_auto = ${ctx.param(v)}`,
    },
    created_within_days: {
      type: 'number', desc: 'créé au cours des N derniers jours',
      apply: (v, ctx) => `t.created_at > now() - make_interval(days => ${ctx.param(v)})`,
    },
    older_than_days: {
      type: 'number', desc: 'ouvert depuis plus de N jours (non résolu)',
      apply: (v, ctx) =>
        `t.resolved_at IS NULL AND t.created_at < now() - make_interval(days => ${ctx.param(v)})`,
    },
    requester: {
      type: 'resolve', resolve: 'user', desc: 'demandeur (nom ou email)',
      apply: (v, ctx) => `t.user_id = ${ctx.param(v)}`,
    },
    tag: {
      type: 'resolve', resolve: 'tag', desc: 'porte un tag donné',
      apply: (v, ctx) =>
        `EXISTS (SELECT 1 FROM ticket_tags tt WHERE tt.ticket_id = t.id AND tt.tag_id = ${ctx.param(v)})`,
    },
  },

  crossFilters: {
    // ticket ↔ device : ticket lié à un poste par hostname.
    device_hostname: {
      type: 'text', desc: 'lié à un poste dont le hostname contient',
      apply: (v, ctx) =>
        `EXISTS (SELECT 1 FROM ticket_devices td JOIN devices dd ON dd.id = td.device_id WHERE td.ticket_id = t.id AND dd.hostname ILIKE ${ctx.param(`%${v}%`)})`,
    },
  },
}

// ── COMPLIANCE ─────────────────────────────────────────────────────────────
// Une ligne = (device, règle, verdict). Permet « quels postes échouent à X ».
// NB : agent_seen_recent est recalculé live dans la route compliance ; ici on
// lit la table brute (verdict figé au dernier checkin). Documenté, accepté v1.
const compliance = {
  table: 'compliance_results cr',
  joins: [
    'JOIN devices d ON d.id = cr.device_id',
    'LEFT JOIN users_cache u ON u.entra_id = d.assigned_user_id',
  ],
  select: `
    cr.device_id, d.hostname, cr.rule_id, cr.status, cr.severity,
    cr.value, cr.evaluated_at, u.display_name AS user_name`,
  sort: {
    severity:     `CASE cr.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
    evaluated_at: 'cr.evaluated_at',
    hostname:     'd.hostname',
  },
  defaultSort: { field: 'severity', dir: 'asc' },
  defaultLimit: 200,
  maxLimit: 1000,

  filters: {
    rule: {
      type: 'enum', enum: RULE_IDS, desc: 'identifiant de règle',
      apply: (v, ctx) => `cr.rule_id = ${ctx.param(v)}`,
    },
    status: {
      type: 'enum', enum: ['pass', 'fail', 'not_applicable'], desc: 'verdict',
      apply: (v, ctx) => `cr.status = ${ctx.param(v)}`,
    },
    severity: {
      type: 'enum', enum: ['low', 'medium', 'high', 'critical'], desc: 'sévérité',
      apply: (v, ctx) => `cr.severity = ${ctx.param(v)}`,
    },
    hostname_contains: {
      type: 'text', desc: 'hostname du poste contient',
      apply: (v, ctx) => `d.hostname ILIKE ${ctx.param(`%${v}%`)}`,
    },
  },

  crossFilters: {},
}

export const REGISTRY = { devices, tickets, compliance }

export const RESOURCES = Object.keys(REGISTRY)

// Liste lisible (pour le prompt LLM et la doc) : ressources → filtres + métadonnées.
export function describeRegistry() {
  const out = {}
  for (const [name, r] of Object.entries(REGISTRY)) {
    const describe = (defs) => Object.fromEntries(
      Object.entries(defs).map(([k, f]) => [k, {
        type: f.type,
        ...(f.enum ? { enum: f.enum } : {}),
        ...(f.resolve ? { resolve: f.resolve } : {}),
        desc: f.desc,
      }])
    )
    out[name] = {
      filters:      describe(r.filters),
      crossFilters: describe(r.crossFilters || {}),
      sort:         Object.keys(r.sort),
      defaultLimit: r.defaultLimit,
      maxLimit:     r.maxLimit,
    }
  }
  return out
}
