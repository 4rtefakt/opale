// Configuration de la barre du bas mobile, partagée entre le rendu de la nav
// (mobile-app.js) et l'écran de réglage (settings.js).
//
// MOBILE_NAV_ITEMS = ensemble FERMÉ des vues sélectionnables comme raccourci,
// route → { icon Tabler, clé i18n du label }. DOIT rester synchro avec
// MOBILE_NAV_ROUTES côté serveur (api/modules/core/lib/prefs.js), qui fait foi.

export const MOBILE_NAV_ITEMS = {
  dashboard:  { icon: 'ti-layout-dashboard', labelKey: 'mobile.nav.route.dashboard' },
  postes:     { icon: 'ti-device-laptop',    labelKey: 'mobile.nav.route.postes' },
  alertes:    { icon: 'ti-bell',             labelKey: 'mobile.nav.route.alertes' },
  tickets:    { icon: 'ti-ticket',           labelKey: 'mobile.nav.route.tickets' },
  scripts:    { icon: 'ti-terminal-2',       labelKey: 'mobile.nav.route.scripts' },
  stock:      { icon: 'ti-package',          labelKey: 'mobile.nav.route.stock' },
  onboarding: { icon: 'ti-user-plus',        labelKey: 'mobile.nav.route.onboarding' },
  rapports:   { icon: 'ti-chart-bar',        labelKey: 'mobile.nav.route.rapports' },
  audit:      { icon: 'ti-list-details',     labelKey: 'mobile.nav.route.audit' },
  packages:   { icon: 'ti-rocket',           labelKey: 'mobile.nav.route.packages' },
  conformite: { icon: 'ti-shield-check',     labelKey: 'mobile.nav.route.conformite' },
  ask:        { icon: 'ti-sparkles',         labelKey: 'mobile.nav.route.ask' },
}

// Les 4 raccourcis par défaut (utilisés tant que l'utilisateur n'a rien choisi
// ou si la pref serveur est absente/illisible).
export const MOBILE_NAV_DEFAULT = ['dashboard', 'postes', 'alertes', 'tickets']

// Nettoie une valeur de pref mobile_nav (potentiellement absente/corrompue) :
// garde les routes connues, sans doublon, max 4 ; retombe sur le défaut si vide.
// Miroir tolérant de la validation serveur — ici on ne rejette pas, on assainit
// pour ne jamais rendre une nav cassée.
export function sanitizeMobileNav(value) {
  if (!Array.isArray(value)) return [...MOBILE_NAV_DEFAULT]
  const seen = new Set()
  const out  = []
  for (const r of value) {
    if (MOBILE_NAV_ITEMS[r] && !seen.has(r)) {
      seen.add(r)
      out.push(r)
      if (out.length === 4) break
    }
  }
  return out.length ? out : [...MOBILE_NAV_DEFAULT]
}
