// Ask Opale — résolution des valeurs « enum-ish » (fuzzy → canonique).
//
// Les filtres type:'resolve' portent une valeur en langage naturel ("Compta",
// "Marie Durand", "Réseau") qu'il faut traduire en identifiant canonique avant
// compilation : nom de groupe → UUID, utilisateur → entra_id, tag → UUID,
// département → libellé exact stocké. La résolution hit la DB ; on prend un
// `db` injectable (objet avec .query) pour rester testable.
//
// Stratégie de matching, par ordre :
//   1. égalité insensible à la casse  → match certain
//   2. un seul candidat ILIKE %v%     → match unique
//   3. plusieurs candidats            → ambigu : erreur listant les candidats
//   0. aucun candidat                 → introuvable : erreur
//
// Le rejet est explicite (pas de "best effort") : mieux vaut dire "groupe
// introuvable" que requêter sur une valeur fausse silencieusement.

import { REGISTRY } from './registry.js'

const KINDS = {
  group: {
    sql:    `SELECT id AS value, name AS label FROM groups WHERE name ILIKE $1 ORDER BY length(name) ASC LIMIT 6`,
    noun:   'groupe',
  },
  user: {
    sql:    `SELECT entra_id AS value, display_name AS label, email AS email
             FROM users_cache WHERE display_name ILIKE $1 OR email ILIKE $1
             ORDER BY length(coalesce(display_name, email)) ASC LIMIT 6`,
    noun:   'utilisateur',
    extraExact: (row, v) => eqCi(row.email, v),
  },
  department: {
    sql:    `SELECT DISTINCT department AS value, department AS label
             FROM users_cache WHERE department ILIKE $1 AND department IS NOT NULL LIMIT 6`,
    noun:   'département',
  },
  tag: {
    sql:    `SELECT id AS value, name AS label FROM tags WHERE name ILIKE $1 ORDER BY length(name) ASC LIMIT 6`,
    noun:   'tag',
  },
}

function eqCi(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

async function resolveOne(db, kind, raw) {
  const cfg = KINDS[kind]
  if (!cfg) return { error: `type de résolution non géré : ${kind}` }

  const { rows } = await db.query(cfg.sql, [`%${raw}%`])
  if (!rows.length) return { error: `${cfg.noun} introuvable : « ${raw} »` }

  // 1) égalité exacte (label, ou champ exact additionnel ex: email).
  const exact = rows.find(r => eqCi(r.label, raw) || (cfg.extraExact && cfg.extraExact(r, raw)))
  if (exact) return { value: exact.value }

  // 2) un seul candidat → on tranche.
  if (rows.length === 1) return { value: rows[0].value }

  // 3) ambigu.
  const labels = rows.map(r => r.label).filter(Boolean).join(', ')
  return { error: `${cfg.noun} ambigu : « ${raw} » → ${labels}` }
}

// Walk filters + cross du spec, résout les valeurs type:'resolve' en place.
// Retourne { ok:true, spec } (nouveau spec avec valeurs canoniques) ou
// { ok:false, errors }.
export async function resolveSpec(db, spec) {
  const res = REGISTRY[spec.resource]
  const errors = []
  const out = { ...spec, filters: { ...spec.filters }, cross: { ...spec.cross } }

  const groups = [
    ['filters', res.filters,       out.filters],
    ['cross',   res.crossFilters || {}, out.cross],
  ]

  for (const [, defs, target] of groups) {
    for (const [name, value] of Object.entries(target)) {
      const def = defs[name]
      if (def?.type !== 'resolve') continue
      const r = await resolveOne(db, def.resolve, value)
      if (r.error) errors.push(r.error)
      else target[name] = r.value
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, spec: out }
}
