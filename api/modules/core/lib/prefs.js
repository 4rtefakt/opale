// Validation des préférences utilisateur (stockées en JSONB dans user_prefs).
//
// PATCH /api/me/prefs est une frontière système : on n'écrit jamais une clé ou
// une valeur non validée, même si le client est censé déjà filtrer. Mécanisme
// extensible : chaque pref connue a un validateur dans PREF_VALIDATORS ; une
// clé absente du registre est rejetée (400). Pour ajouter une pref, ajouter une
// entrée au registre — pas besoin de toucher à la route.

// Ensemble FERMÉ des routes mobiles autorisées dans la barre du bas. DOIT
// rester synchro avec MOBILE_NAV_ITEMS côté front
// (front/views/mobile/nav-config.js). Le serveur fait foi.
export const MOBILE_NAV_ROUTES = new Set([
  'dashboard', 'postes', 'alertes', 'tickets', 'scripts', 'stock',
  'onboarding', 'rapports', 'audit', 'packages', 'conformite', 'ask',
])

// Valide la pref mobile_nav : tableau de 1 à 4 identifiants de routes DISTINCTS,
// tous dans l'ensemble autorisé. Retourne { ok:true, value } ou { ok:false, error }.
export function validateMobileNav(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'mobile_nav doit être un tableau' }
  }
  if (value.length < 1 || value.length > 4) {
    return { ok: false, error: 'mobile_nav doit contenir 1 à 4 entrées' }
  }
  const seen = new Set()
  for (const r of value) {
    if (typeof r !== 'string' || !MOBILE_NAV_ROUTES.has(r)) {
      return { ok: false, error: `mobile_nav : route invalide « ${r} »` }
    }
    if (seen.has(r)) {
      return { ok: false, error: `mobile_nav : doublon « ${r} »` }
    }
    seen.add(r)
  }
  return { ok: true, value }
}

// Registre des prefs connues → validateur.
const PREF_VALIDATORS = {
  mobile_nav: validateMobileNav,
}

// Valide un patch de prefs (merge superficiel). Rejette tout corps non-objet,
// vide, ou contenant une clé inconnue. Retourne { ok:true, patch } (normalisé)
// ou { ok:false, error }.
export function validatePrefsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'corps attendu : objet de préférences' }
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    return { ok: false, error: 'aucune préférence fournie' }
  }
  const out = {}
  for (const key of keys) {
    const validate = PREF_VALIDATORS[key]
    if (!validate) {
      return { ok: false, error: `préférence inconnue : ${key}` }
    }
    const res = validate(patch[key])
    if (!res.ok) return res
    out[key] = res.value
  }
  return { ok: true, patch: out }
}
