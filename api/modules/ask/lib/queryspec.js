// Ask Opale — validation du QuerySpec.
//
// Le QuerySpec est le SEUL contrat entre le LLM et le moteur de requêtes.
// La validation ci-dessous EST la frontière de sécurité : tout champ inconnu,
// toute valeur d'enum non autorisée, tout type incohérent est rejeté AVANT de
// toucher la base. Le compilateur (compile.js) ne reçoit que des specs validés.
//
// Forme acceptée :
//   {
//     resource: 'devices' | 'tickets' | 'compliance',
//     filters?:  { <filterName>: <value> },        // filtres directs
//     cross?:    { <crossFilterName>: <value> },   // filtres relationnels réservés
//     sort?:     '<field>' | { field, dir: 'asc'|'desc' },
//     limit?:    number,
//   }
//
// Retour : { ok: true, spec } (spec normalisé) ou { ok: false, errors: [...] }.
// Les valeurs des filtres `type:'resolve'` sont laissées telles quelles
// (chaînes) : leur résolution nom→id se fait ensuite dans resolve.js.

import { REGISTRY } from './registry.js'

const TEXT_MAX = 200

// Lookup de registre par clé venant du LLM : propriété PROPRE uniquement.
// `defs[name]` seul résolvait aussi `__proto__`, `constructor`, `toString`…
// via la chaîne de prototypes (valeur truthy → contrôle contourné).
function ownEntry(obj, key) {
  return obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined
}

function coerceNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

// Valide un groupe de filtres (filters OU cross) contre leurs définitions.
// Pousse les erreurs dans `errors` et retourne l'objet normalisé.
function validateFilterGroup(input, defs, errors, groupLabel) {
  const out = {}
  if (input == null) return out
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push(`${groupLabel} doit être un objet`)
    return out
  }

  for (const [name, rawValue] of Object.entries(input)) {
    const def = ownEntry(defs, name)
    if (!def) {
      errors.push(`${groupLabel} inconnu : « ${name} »`)
      continue
    }
    if (rawValue == null) continue // champ vide ignoré (tolérant côté LLM)

    switch (def.type) {
      case 'enum': {
        if (!def.enum.includes(rawValue)) {
          errors.push(`${groupLabel}.${name} : valeur « ${rawValue} » hors liste (${def.enum.join(', ')})`)
          continue
        }
        out[name] = rawValue
        break
      }
      case 'text':
      case 'resolve': {
        if (typeof rawValue !== 'string' || rawValue.trim() === '') {
          errors.push(`${groupLabel}.${name} : chaîne non vide attendue`)
          continue
        }
        out[name] = rawValue.trim().slice(0, TEXT_MAX)
        break
      }
      case 'number': {
        const n = coerceNumber(rawValue)
        if (n === null) {
          errors.push(`${groupLabel}.${name} : nombre attendu, reçu « ${rawValue} »`)
          continue
        }
        out[name] = n
        break
      }
      case 'bool': {
        const b = coerceBool(rawValue)
        if (b === null) {
          errors.push(`${groupLabel}.${name} : booléen attendu, reçu « ${rawValue} »`)
          continue
        }
        out[name] = b
        break
      }
      default:
        errors.push(`${groupLabel}.${name} : type de filtre non géré (${def.type})`)
    }
  }
  return out
}

export function validateQuerySpec(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['QuerySpec doit être un objet'] }
  }

  const resource = raw.resource
  const res = ownEntry(REGISTRY, resource)
  if (!res) {
    return { ok: false, errors: [`resource inconnue : « ${resource} » (attendu : ${Object.keys(REGISTRY).join(', ')})`] }
  }

  const filters = validateFilterGroup(raw.filters, res.filters, errors, 'filters')
  const cross   = validateFilterGroup(raw.cross, res.crossFilters || {}, errors, 'cross')

  // sort : chaîne (=> asc) ou { field, dir }. Champ doit être triable.
  let sort = res.defaultSort
  if (raw.sort != null) {
    const field = typeof raw.sort === 'string' ? raw.sort : raw.sort?.field
    const dir   = typeof raw.sort === 'object' ? raw.sort?.dir : undefined
    if (!field || !ownEntry(res.sort, field)) {
      errors.push(`sort.field inconnu : « ${field} » (triables : ${Object.keys(res.sort).join(', ')})`)
    } else {
      const d = dir === 'desc' ? 'desc' : 'asc'
      sort = { field, dir: d }
    }
  }

  // limit : entier positif borné à maxLimit.
  let limit = res.defaultLimit
  if (raw.limit != null) {
    const n = coerceNumber(raw.limit)
    if (n === null || n <= 0) {
      errors.push(`limit : entier positif attendu`)
    } else {
      limit = Math.min(Math.floor(n), res.maxLimit)
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, spec: { resource, filters, cross, sort, limit } }
}
