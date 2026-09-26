// Ask Opale — compilation QuerySpec → SQL paramétré (couche déterministe).
//
// Reçoit un spec DÉJÀ validé (queryspec.js) et DÉJÀ résolu (resolve.js, pour
// les filtres type:'resolve'). Produit { text, params } : un SELECT
// entièrement paramétré. Les identifiants (table/colonnes/fragments) viennent
// exclusivement du registre — seules les valeurs passent en $n. Zéro LLM, zéro
// I/O : fonction pure, testable directement.

import { REGISTRY } from './registry.js'

export function compile(spec, opts = {}) {
  const res = Object.hasOwn(REGISTRY, spec.resource) ? REGISTRY[spec.resource] : null
  if (!res) throw new Error(`compile: resource inconnue ${spec.resource}`)

  const params = []
  const ctx = {
    opts,
    param(value) {
      params.push(value)
      return `$${params.length}`
    },
  }

  const conditions = []
  for (const [name, value] of Object.entries(spec.filters || {})) {
    conditions.push(res.filters[name].apply(value, ctx))
  }
  for (const [name, value] of Object.entries(spec.cross || {})) {
    conditions.push(res.crossFilters[name].apply(value, ctx))
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const joins = (res.joins || []).join('\n  ')

  const sort = spec.sort || res.defaultSort
  const sortSql = res.sort[sort.field]
  const dir = sort.dir === 'desc' ? 'DESC' : 'ASC'

  const limitPh = ctx.param(spec.limit ?? res.defaultLimit)

  const text = `
    SELECT ${res.select.trim()},
           COUNT(*) OVER() AS _total
    FROM ${res.table}
    ${joins}
    ${where}
    ORDER BY ${sortSql} ${dir}
    LIMIT ${limitPh}`.trim()

  return { text, params }
}
