// « Plus » — tout ce qui n'est pas dans la barre du bas : compte, accès aux
// autres écrans (les onglets déjà en raccourci ne sont pas répétés), réglages,
// déconnexion.

import { MOBILE_NAV_ITEMS } from '/views/mobile/nav-config.js'

// Ordre d'affichage des tuiles ; couleur = repère visuel stable par écran.
const TILES = [
  ['today', 'blue'], ['dashboard', 'blue'], ['tickets', 'amber'], ['postes', 'green'], ['alertes', 'red'],
  ['ask', 'purple'], ['conformite', 'green'], ['scripts', 'amber'], ['packages', 'indigo'],
  ['onboarding', 'purple'], ['rapports', 'teal'], ['stock', 'orange'], ['audit', 'red'],
]

export async function renderMenu(el) {
  const user = window.appState?.user
  const inNav = new Set(window.mNavRoutes?.() || [])
  const tiles = TILES.filter(([r]) => !inNav.has(r))

  el.innerHTML = `
    <div class="m-header big">
      <div class="m-head-text"><h1>${esc(t('mobile.nav.more'))}</h1></div>
      <div class="m-actions"><button class="m-icon-btn" onclick="window.location.hash='#/search'" title="${esc(t('mobile.dashboard.search_title'))}"><i class="ti ti-search"></i></button></div>
    </div>
    <div class="m-scroll">

      <!-- Compte -->
      <button class="m-card tap" style="display:flex;align-items:center;gap:14px;text-align:left" onclick="window.location.hash='#/settings'">
        <div class="m-av" style="width:44px;height:44px;font-size:16px">${user ? initials(user.displayName) : '?'}</div>
        <div style="min-width:0;flex:1">
          <div style="font-weight:600;font-size:15px">${esc(user?.displayName || '—')}</div>
          <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user?.email || '')}</div>
        </div>
        <span class="m-pill m-pill-off"><i class="ti ti-settings" style="font-size:12px"></i> ${esc(t('mobile.settings.title'))}</span>
      </button>

      <!-- Écrans -->
      <div class="m-menu-grid">
        ${tiles.map(([r, color]) => `
        <button class="m-menu-tile ${color}" onclick="window.location.hash='#/${r}'">
          <i class="ti ${MOBILE_NAV_ITEMS[r].icon}"></i>
          <span>${esc(t(MOBILE_NAV_ITEMS[r].labelKey))}</span>
        </button>`).join('')}
        <button class="m-menu-tile green" onclick="mSyncIntune(this)">
          <i class="ti ti-refresh"></i>
          <span>${esc(t('mobile.dashboard.sync_title'))}</span>
        </button>
      </div>

      <!-- Déconnexion -->
      <div class="m-panel">
        <button class="m-menu-row" style="color:var(--red)" onclick="window.auth.logout()">
          <i class="ti ti-logout"></i>
          <span>${esc(t('mobile.menu.logout'))}</span>
        </button>
      </div>

      <div class="m-muted" style="text-align:center;font-size:11px;padding-bottom:8px">
        ${esc(window.ENV?.BRANDING?.product_name || 'Opale')}
      </div>
    </div>`

  window.mSyncIntune = (btn) => withBusy(btn, async () => {
    try {
      await window.api.syncIntune()
      window.showToast(t('mobile.dashboard.toast.sync_started'), 'success')
    } catch { window.showToast(t('mobile.dashboard.toast.error'), 'error') }
  })
}

function initials(str) {
  return (str || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
