// Ask Opale — scoring d'un cas d'eval (fonction pure, testable sans réseau).
//
// Compare le QuerySpec produit par le LLM (déjà validé, donc normalisé) au
// QuerySpec attendu d'un cas. Un cas peut déclarer des alternatives également
// acceptables (`alt`) — ex: « postes sans BitLocker » se traduit aussi bien en
// filters.bitlocker_active=false qu'en cross.failing_rule=bitlocker_c_active.
// On retient la meilleure correspondance.
//
// Statut :
//   'exact'   : bonne ressource, tous les filtres/cross attendus présents et
//               corrects, aucun champ superflu, sort/limit conformes si
//               spécifiés dans l'attendu.
//   'partial' : bonne ressource mais filtres manquants/superflus/incorrects.
//   'fail'    : mauvaise ressource (ou rien d'exploitable).

function valEq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  }
  return a === b
}

// Compare un groupe (filters ou cross). Retourne { matched, missing, extra }.
function diffGroup(expected = {}, actual = {}) {
  const missing = []
  let matched = 0
  for (const [k, v] of Object.entries(expected)) {
    if (k in actual && valEq(actual[k], v)) matched++
    else missing.push(k)
  }
  const extra = Object.keys(actual).filter(k => !(k in expected))
  return { matched, missing, extra }
}

// Extrait le spec « attendu » d'un cas (retire les méta q/alt).
function specOf(caseObj) {
  const { q, alt, ...spec } = caseObj
  return spec
}

function matchOne(expected, actual) {
  if (!actual || expected.resource !== actual.resource) {
    return { score: 0, resourceOk: false, missing: ['resource'], extra: [] }
  }
  const f = diffGroup(expected.filters, actual.filters)
  const c = diffGroup(expected.cross, actual.cross)
  const missing = [...f.missing.map(k => `filters.${k}`), ...c.missing.map(k => `cross.${k}`)]
  const extra   = [...f.extra.map(k => `filters.${k}`),   ...c.extra.map(k => `cross.${k}`)]

  // sort / limit : vérifiés seulement si l'attendu les précise.
  if (expected.sort) {
    const okField = actual.sort?.field === expected.sort.field
    const okDir   = !expected.sort.dir || actual.sort?.dir === expected.sort.dir
    if (!okField || !okDir) missing.push('sort')
  }
  if (expected.limit != null && actual.limit !== expected.limit) missing.push('limit')

  const expectedCount =
    Object.keys(expected.filters || {}).length +
    Object.keys(expected.cross || {}).length || 1
  const matched = f.matched + c.matched
  // score : part des attendus matchés, pénalisé par les superflus.
  const score = Math.max(0, (matched - 0.25 * extra.length)) / Math.max(expectedCount, 1)

  return { score, resourceOk: true, missing, extra }
}

export function scoreCase(caseObj, actual) {
  const candidates = [specOf(caseObj), ...((caseObj.alt || []))]
  let best = null
  for (const exp of candidates) {
    const m = matchOne(exp, actual)
    if (!best || m.score > best.score) best = m
  }

  let status
  if (!best.resourceOk) status = 'fail'
  else if (best.missing.length === 0 && best.extra.length === 0) status = 'exact'
  else status = 'partial'

  return { status, ...best }
}
