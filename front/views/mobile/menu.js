export async function renderMenu(el) {
  const user = window.appState?.user

  el.innerHTML = `
    <div class="m-header">
      <h1>${esc(t('mobile.nav.more'))}</h1>
    </div>
    <div class="m-scroll" style="padding:16px;display:flex;flex-direction:column;gap:16px">

      <!-- Compte -->
      <div class="m-panel">
        <div style="display:flex;align-items:center;gap:14px;padding:16px">
          <div class="m-av" style="width:44px;height:44px;font-size:16px;flex-shrink:0">
            ${user ? initials(user.displayName) : '?'}
          </div>
          <div style="min-width:0">
            <div style="font-weight:600;font-size:15px">${esc(user?.displayName || '—')}</div>
            <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user?.email || '')}</div>
            ${user?.isAdmin ? `<span class="m-pill m-pill-on" style="margin-top:4px;display:inline-block">${esc(t('mobile.menu.admin'))}</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Grille d'accès rapide -->
      <div class="m-menu-grid">
        <button class="m-menu-tile blue" onclick="window.location.hash='#/ask'">
          <i class="ti ti-sparkles"></i>
          <span>${esc(t('mobile.menu.ask'))}</span>
        </button>
        <button class="m-menu-tile green" onclick="window.location.hash='#/conformite'">
          <i class="ti ti-shield-check"></i>
          <span>${esc(t('mobile.menu.compliance'))}</span>
        </button>
        <button class="m-menu-tile blue" onclick="window.location.hash='#/settings'">
          <i class="ti ti-settings"></i>
          <span>${esc(t('mobile.settings.title'))}</span>
        </button>
        <button class="m-menu-tile amber" onclick="window.location.hash='#/scripts'">
          <i class="ti ti-terminal-2"></i>
          <span>${esc(t('mobile.nav.route.scripts'))}</span>
        </button>
        <button class="m-menu-tile green" onclick="mSyncIntune(this)">
          <i class="ti ti-refresh"></i>
          <span>${esc(t('mobile.dashboard.sync_title'))}</span>
        </button>
        <button class="m-menu-tile purple" onclick="window.location.hash='#/onboarding'">
          <i class="ti ti-user-plus"></i>
          <span>${esc(t('mobile.nav.route.onboarding'))}</span>
        </button>
        <button class="m-menu-tile teal" onclick="window.location.hash='#/rapports'">
          <i class="ti ti-chart-bar"></i>
          <span>${esc(t('mobile.nav.route.rapports'))}</span>
        </button>
        <button class="m-menu-tile orange" onclick="window.location.hash='#/stock'">
          <i class="ti ti-package"></i>
          <span>${esc(t('mobile.nav.route.stock'))}</span>
        </button>
        <button class="m-menu-tile red" onclick="window.location.hash='#/audit'">
          <i class="ti ti-list-details"></i>
          <span>${esc(t('mobile.nav.route.audit'))}</span>
        </button>
        <button class="m-menu-tile indigo" onclick="window.location.hash='#/packages'">
          <i class="ti ti-rocket"></i>
          <span>${esc(t('mobile.nav.route.packages'))}</span>
        </button>
      </div>

      <!-- Déconnexion -->
      <div class="m-panel">
        <button class="m-menu-row" style="color:var(--red)" onclick="window.auth.logout()">
          <i class="ti ti-logout"></i>
          <span>${esc(t('mobile.menu.logout'))}</span>
        </button>
      </div>

      <div style="text-align:center;font-size:11px;color:var(--text-tertiary);padding-bottom:8px">
        ${esc(window.ENV?.BRANDING?.product_name || 'Opale')}
      </div>
    </div>`

  window.mSyncIntune = (btn) => withBusy(btn, async () => {
    try {
      await window.api.syncIntune()
      window.showToast(t('mobile.menu.toast.sync_started'), 'success')
    } catch { window.showToast(t('mobile.menu.toast.error'), 'error') }
  })
}

function initials(str) {
  return (str || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
