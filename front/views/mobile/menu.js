export async function renderMenu(el) {
  const user = window.appState?.user

  el.innerHTML = `
    <div class="m-header">
      <h1>Plus</h1>
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
            ${user?.isAdmin ? `<span class="m-pill m-pill-on" style="margin-top:4px;display:inline-block">Admin</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Grille d'accès rapide -->
      <div class="m-menu-grid">
        <button class="m-menu-tile blue" onclick="window.location.hash='#/settings'">
          <i class="ti ti-settings"></i>
          <span>Paramètres</span>
        </button>
        <button class="m-menu-tile amber" onclick="window.location.hash='#/scripts'">
          <i class="ti ti-terminal-2"></i>
          <span>Scripts</span>
        </button>
        <button class="m-menu-tile green" onclick="mSyncIntune()">
          <i class="ti ti-refresh"></i>
          <span>Sync Intune</span>
        </button>
        <button class="m-menu-tile purple" onclick="window.location.hash='#/onboarding'">
          <i class="ti ti-user-plus"></i>
          <span>Onboarding</span>
        </button>
        <button class="m-menu-tile teal" onclick="window.location.hash='#/rapports'">
          <i class="ti ti-chart-bar"></i>
          <span>Rapports</span>
        </button>
        <button class="m-menu-tile orange" onclick="window.location.hash='#/stock'">
          <i class="ti ti-package"></i>
          <span>Stock</span>
        </button>
        <button class="m-menu-tile red" onclick="window.location.hash='#/audit'">
          <i class="ti ti-list-details"></i>
          <span>Logs</span>
        </button>
        <button class="m-menu-tile blue" style="background:var(--indigo,#6366f1)" onclick="window.location.hash='#/packages'">
          <i class="ti ti-rocket"></i>
          <span>Déploiement</span>
        </button>
      </div>

      <!-- Déconnexion -->
      <div class="m-panel">
        <button class="m-menu-row" style="color:var(--red)" onclick="window.auth.logout()">
          <i class="ti ti-logout"></i>
          <span>Déconnexion</span>
        </button>
      </div>

      <div style="text-align:center;font-size:11px;color:var(--text-tertiary);padding-bottom:8px">
        ${esc(window.ENV?.BRANDING?.product_name || 'Opale')}
      </div>
    </div>`

  window.mSyncIntune = async () => {
    try {
      await window.api.syncIntune()
      window.showToast('Sync Intune lancée', 'success')
    } catch { window.showToast('Erreur', 'error') }
  }
}

function initials(str) {
  return (str || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
