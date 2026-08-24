import { MOBILE_NAV_ITEMS, sanitizeMobileNav } from '/views/mobile/nav-config.js'

let _data = null
// Sélection locale des raccourcis de la barre du bas (éditée en place, poussée
// au serveur uniquement au clic « Enregistrer »).
let _navSel = []

export async function renderSettings(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="window.location.hash='#/menu'">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1>${t('mobile.settings.title')}</h1>
    </div>
    <div class="m-scroll" id="m-settings-body">
      <div style="display:flex;justify-content:center;padding:40px"><div class="m-spinner"></div></div>
    </div>`

  window.mAddSSHKey    = mAddSSHKey
  window.mDeleteSSHKey = mDeleteSSHKey
  window.mAddToken     = mAddToken
  window.mRevokeToken  = mRevokeToken
  window.mToggleBio    = mToggleBio
  window.mNavAdd       = mNavAdd
  window.mNavRemove    = mNavRemove
  window.mNavMove      = mNavMove
  window.mNavSave      = mNavSave

  await loadSettings()
}

async function loadSettings() {
  try {
    // Prefs en parallèle ; un échec prefs ne doit pas casser la page réglages.
    const [settings, prefs] = await Promise.all([
      window.api.getSettings(),
      window.api.getMyPrefs().catch(() => ({})),
    ])
    _data   = settings
    _navSel = sanitizeMobileNav(prefs?.mobile_nav)
    renderBody()
  } catch (err) {
    const body = document.getElementById('m-settings-body')
    if (body) body.innerHTML = mErrorBox(err.message, () => loadSettings())
  }
}

function renderBody() {
  const body = document.getElementById('m-settings-body')
  if (!body) return

  const sshKeys = _data?.ssh_keys || []
  const tokens  = _data?.tokens  || []

  const bioSupported = window.bio?.isSupported?.() ?? false
  const bioEnabled   = window.bio?.isEnabled?.()   ?? false
  const locale       = window.getLocale?.() || 'fr'

  // Endonymes volontairement non traduits (chaque langue dans sa propre langue).
  const langBtn = (code, label) => `
    <button class="m-btn-primary" style="flex:1;${code === locale ? '' : 'background:var(--bg-tertiary);color:var(--text-secondary)'}"
      onclick="window.setLocale('${code}')">${label}</button>`

  body.innerHTML = `
    <div style="padding:16px;display:flex;flex-direction:column;gap:16px">

      <!-- Langue -->
      <div class="m-panel">
        <div class="m-panel-header"><i class="ti ti-language"></i> ${t('mobile.settings.lang.title')}</div>
        <div style="padding:14px 16px;display:flex;gap:10px">
          ${langBtn('fr', '🇫🇷 Français')}
          ${langBtn('en', '🇬🇧 English')}
        </div>
      </div>

      <!-- Barre du bas -->
      <div class="m-panel">
        <div class="m-panel-header"><i class="ti ti-layout-navbar"></i> ${t('mobile.settings.nav.title')}</div>
        <div style="padding:10px 16px;font-size:12px;color:var(--text-tertiary)">${t('mobile.settings.nav.sub')}</div>
        <div id="m-navpref"></div>
      </div>

      <!-- Sécurité -->
      <div class="m-panel">
        <div class="m-panel-header"><i class="ti ti-fingerprint"></i> ${t('mobile.settings.security.title')}</div>
        <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:500">${t('mobile.settings.security.bio_label')}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">
              ${!bioSupported ? t('mobile.settings.security.bio_unsupported') : bioEnabled ? t('mobile.settings.security.bio_enabled_sub') : t('mobile.settings.security.bio_disabled_sub')}
            </div>
          </div>
          ${bioSupported ? `
          <button class="m-btn-primary" style="padding:6px 14px;font-size:12px;background:${bioEnabled ? 'var(--red)' : 'var(--blue)'}"
            onclick="mToggleBio()">
            ${bioEnabled ? t('mobile.settings.security.btn.disable') : t('mobile.settings.security.btn.enable')}
          </button>` : ''}
        </div>
      </div>

      <!-- Clés SSH -->
      <div class="m-panel">
        <div class="m-panel-header" style="display:flex;align-items:center">
          <span style="flex:1"><i class="ti ti-key"></i> ${t('mobile.settings.ssh.title')}</span>
          <button class="m-icon-btn" style="padding:0" onclick="mShowAddSSHKey()">
            <i class="ti ti-plus"></i>
          </button>
        </div>
        ${sshKeys.length ? sshKeys.map(k => `
          <div style="display:flex;align-items:center;padding:10px 16px;gap:12px;border-bottom:0.5px solid var(--border)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500">${esc(k.label)}</div>
              <div style="font-size:10px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace">${esc(k.public_key.slice(0, 40))}…</div>
            </div>
            <button class="m-icon-btn" style="color:var(--red)" onclick="mDeleteSSHKey('${esc(k.id)}','${esc(k.label)}',this)">
              <i class="ti ti-trash"></i>
            </button>
          </div>`).join('')
        : `<div style="padding:14px 16px;font-size:13px;color:var(--text-tertiary)">${t('mobile.settings.ssh.empty')}</div>`}
      </div>

      <!-- Tokens agent -->
      <div class="m-panel">
        <div class="m-panel-header" style="display:flex;align-items:center">
          <span style="flex:1"><i class="ti ti-shield-lock"></i> ${t('mobile.settings.tokens.title')}</span>
          <button class="m-icon-btn" style="padding:0" onclick="mShowAddToken()">
            <i class="ti ti-plus"></i>
          </button>
        </div>
        ${tokens.length ? tokens.map(tk => `
          <div style="display:flex;align-items:center;padding:10px 16px;gap:12px;border-bottom:0.5px solid var(--border)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500">${esc(tk.label)}</div>
              <div style="font-size:11px;color:var(--text-tertiary)">${formatRelative(tk.created_at)}</div>
            </div>
            <button class="m-icon-btn" style="color:var(--red)" onclick="mRevokeToken('${esc(tk.id)}','${esc(tk.label)}',this)">
              <i class="ti ti-trash"></i>
            </button>
          </div>`).join('')
        : `<div style="padding:14px 16px;font-size:13px;color:var(--text-tertiary)">${t('mobile.settings.tokens.empty')}</div>`}
      </div>

    </div>`

  renderNavPref()

  window.mShowAddSSHKey = () => {
    window.mShowSheet(`
      <div class="m-sheet-title">${t('mobile.settings.ssh.add_title')}</div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px">
        <div>
          <div class="m-label">${t('mobile.settings.ssh.label')}</div>
          <input class="m-input" id="m-sshk-label" placeholder="${t('mobile.settings.ssh.label_placeholder')}" autocomplete="off">
        </div>
        <div>
          <div class="m-label">${t('mobile.settings.ssh.key_label')}</div>
          <textarea class="m-input" id="m-sshk-key" rows="4" style="resize:none;font-family:monospace;font-size:11px"
            placeholder="ssh-ed25519 AAAA…"></textarea>
        </div>
        <button class="m-btn-primary" onclick="mAddSSHKey(this)">${t('mobile.settings.ssh.btn.add')}</button>
      </div>`)
  }

  window.mShowAddToken = () => {
    window.mShowSheet(`
      <div class="m-sheet-title">${t('mobile.settings.tokens.add_title')}</div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px">
        <div>
          <div class="m-label">${t('mobile.settings.tokens.label')}</div>
          <input class="m-input" id="m-tok-label" placeholder="${t('mobile.settings.tokens.label_placeholder')}" autocomplete="off">
        </div>
        <button class="m-btn-primary" onclick="mAddToken(this)">${t('mobile.settings.tokens.btn.create')}</button>
      </div>`)
  }
}

async function mAddSSHKey(btn) {
  const label = document.getElementById('m-sshk-label')?.value?.trim()
  const key   = document.getElementById('m-sshk-key')?.value?.trim()
  if (!label || !key) return
  await withBusy(btn, async () => {
    try {
      await window.api.addSSHKey({ label, public_key: key })
      window.mCloseSheet()
      window.showToast(t('mobile.settings.ssh.toast.added'), 'success')
      await loadSettings()
    } catch (err) { window.showToast(err.message || t('mobile.settings.toast.error'), 'error') }
  })
}

async function mDeleteSSHKey(id, label, btn) {
  if (!confirm(t('mobile.settings.ssh.confirm_delete', { label }))) return
  await withBusy(btn, async () => {
    try {
      await window.api.deleteSSHKey(id)
      window.showToast(t('mobile.settings.ssh.toast.deleted'), 'success')
      await loadSettings()
    } catch { window.showToast(t('mobile.settings.toast.error'), 'error') }
  })
}

async function mAddToken(btn) {
  const label = document.getElementById('m-tok-label')?.value?.trim()
  if (!label) return
  await withBusy(btn, async () => {
    try {
      const result = await window.api.createToken({ label })
      window.mCloseSheet()
      // Show the token value in a sheet (it's only shown once)
      window.mShowSheet(`
      <div class="m-sheet-title">${t('mobile.settings.tokens.created_title')}</div>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px">${t('mobile.settings.tokens.created_warning')}</p>
      <div style="font-family:monospace;font-size:11px;background:var(--bg-tertiary);padding:12px;border-radius:8px;word-break:break-all;user-select:all">${esc(result.token)}</div>
      <button class="m-btn-primary" style="margin-top:12px" onclick="window.mCloseSheet();loadSettings()">${t('mobile.settings.tokens.btn.close')}</button>`)
      window.loadSettings = loadSettings
      await loadSettings()
    } catch (err) { window.showToast(err.message || t('mobile.settings.toast.error'), 'error') }
  })
}

async function mToggleBio() {
  const bio = window.bio
  if (!bio?.isSupported()) return
  if (bio.isEnabled()) {
    if (!confirm(t('mobile.settings.bio.confirm_disable'))) return
    bio.disable()
    window.showToast(t('mobile.settings.bio.toast.disabled'), 'info')
    renderBody()
    return
  }
  window.showToast(t('mobile.settings.bio.toast.prompt'), 'info')
  const ok = await bio.register()
  if (ok) {
    window.showToast(t('mobile.settings.bio.toast.enabled'), 'success')
    renderBody()
  } else {
    window.showToast(t('mobile.settings.bio.toast.cancelled'), 'error')
  }
}

async function mRevokeToken(id, label, btn) {
  if (!confirm(t('mobile.settings.tokens.confirm_revoke', { label }))) return
  await withBusy(btn, async () => {
    try {
      await window.api.revokeToken(id)
      window.showToast(t('mobile.settings.tokens.toast.revoked'), 'success')
      await loadSettings()
    } catch { window.showToast(t('mobile.settings.toast.error'), 'error') }
  })
}

// ── Barre du bas (raccourcis personnalisables) ──────────────────────────────
// Édition locale de _navSel (1 à 4 raccourcis ordonnés). Re-render in place à
// chaque changement ; la sauvegarde serveur est explicite (bouton Enregistrer).
function renderNavPref() {
  const host = document.getElementById('m-navpref')
  if (!host) return
  const available = Object.keys(MOBILE_NAV_ITEMS).filter(r => !_navSel.includes(r))
  const full      = _navSel.length >= 4

  const selRows = _navSel.map((r, i) => {
    const meta = MOBILE_NAV_ITEMS[r]
    return `<div class="m-navpref-row">
      <span class="m-navpref-num">${i + 1}</span>
      <i class="ti ${meta.icon}"></i>
      <span class="m-navpref-label">${esc(t(meta.labelKey))}</span>
      <button class="m-icon-btn" ${i === 0 ? 'disabled' : ''} onclick="mNavMove('${r}',-1)"><i class="ti ti-chevron-up"></i></button>
      <button class="m-icon-btn" ${i === _navSel.length - 1 ? 'disabled' : ''} onclick="mNavMove('${r}',1)"><i class="ti ti-chevron-down"></i></button>
      <button class="m-icon-btn" style="color:var(--red)" ${_navSel.length <= 1 ? 'disabled' : ''} onclick="mNavRemove('${r}')"><i class="ti ti-x"></i></button>
    </div>`
  }).join('')

  const availRows = available.map(r => {
    const meta = MOBILE_NAV_ITEMS[r]
    return `<div class="m-navpref-row">
      <i class="ti ${meta.icon}" style="margin-left:4px"></i>
      <span class="m-navpref-label">${esc(t(meta.labelKey))}</span>
      <button class="m-icon-btn" style="color:var(--blue)" ${full ? 'disabled' : ''} onclick="mNavAdd('${r}')"><i class="ti ti-plus"></i></button>
    </div>`
  }).join('')

  host.innerHTML = `
    <div class="m-navpref-section">${t('mobile.settings.nav.selected')}</div>
    ${selRows}
    ${available.length ? `<div class="m-navpref-section">${t('mobile.settings.nav.available')}</div>${availRows}` : ''}
    <div style="padding:12px 16px">
      <button class="m-btn-primary" onclick="mNavSave(this)">${t('mobile.settings.nav.btn.save')}</button>
    </div>`
}

function mNavAdd(route) {
  if (_navSel.length < 4 && MOBILE_NAV_ITEMS[route] && !_navSel.includes(route)) {
    _navSel.push(route)
    renderNavPref()
  }
}

function mNavRemove(route) {
  if (_navSel.length > 1) {
    _navSel = _navSel.filter(r => r !== route)
    renderNavPref()
  }
}

function mNavMove(route, dir) {
  const i = _navSel.indexOf(route)
  const j = i + dir
  if (i < 0 || j < 0 || j >= _navSel.length) return
  ;[_navSel[i], _navSel[j]] = [_navSel[j], _navSel[i]]
  renderNavPref()
}

async function mNavSave(btn) {
  await withBusy(btn, async () => {
    try {
      const saved = await window.api.updateMyPrefs({ mobile_nav: _navSel })
      _navSel = sanitizeMobileNav(saved?.mobile_nav)
      window.mRenderBottomNav?.([..._navSel])   // rafraîchit la barre en direct
      renderNavPref()
      window.showToast(t('mobile.settings.nav.toast.saved'), 'success')
    } catch (err) { window.showToast(err.message || t('mobile.settings.toast.error'), 'error') }
  })
}
