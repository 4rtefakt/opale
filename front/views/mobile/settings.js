let _data = null

export async function renderSettings(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
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

  await loadSettings()
}

async function loadSettings() {
  try {
    _data = await window.api.getSettings()
    renderBody()
  } catch (err) {
    const body = document.getElementById('m-settings-body')
    if (body) body.innerHTML =
      `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function renderBody() {
  const body = document.getElementById('m-settings-body')
  if (!body) return

  const sshKeys = _data?.ssh_keys || []
  const tokens  = _data?.tokens  || []

  const bioSupported = window.bio?.isSupported?.() ?? false
  const bioEnabled   = window.bio?.isEnabled?.()   ?? false

  body.innerHTML = `
    <div style="padding:16px;display:flex;flex-direction:column;gap:16px">

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
            <button class="m-icon-btn" style="color:var(--red)" onclick="mDeleteSSHKey('${esc(k.id)}','${esc(k.label)}')">
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
            <button class="m-icon-btn" style="color:var(--red)" onclick="mRevokeToken('${esc(tk.id)}','${esc(tk.label)}')">
              <i class="ti ti-trash"></i>
            </button>
          </div>`).join('')
        : `<div style="padding:14px 16px;font-size:13px;color:var(--text-tertiary)">${t('mobile.settings.tokens.empty')}</div>`}
      </div>

    </div>`

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
        <button class="m-btn-primary" onclick="mAddSSHKey()">${t('mobile.settings.ssh.btn.add')}</button>
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
        <button class="m-btn-primary" onclick="mAddToken()">${t('mobile.settings.tokens.btn.create')}</button>
      </div>`)
  }
}

async function mAddSSHKey() {
  const label = document.getElementById('m-sshk-label')?.value?.trim()
  const key   = document.getElementById('m-sshk-key')?.value?.trim()
  if (!label || !key) return
  try {
    await window.api.addSSHKey({ label, public_key: key })
    window.mCloseSheet()
    window.showToast(t('mobile.settings.ssh.toast.added'), 'success')
    await loadSettings()
  } catch (err) { window.showToast(err.message || t('mobile.settings.toast.error'), 'error') }
}

async function mDeleteSSHKey(id, label) {
  if (!confirm(t('mobile.settings.ssh.confirm_delete', { label }))) return
  try {
    await window.api.deleteSSHKey(id)
    window.showToast(t('mobile.settings.ssh.toast.deleted'), 'success')
    await loadSettings()
  } catch { window.showToast(t('mobile.settings.toast.error'), 'error') }
}

async function mAddToken() {
  const label = document.getElementById('m-tok-label')?.value?.trim()
  if (!label) return
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

async function mRevokeToken(id, label) {
  if (!confirm(t('mobile.settings.tokens.confirm_revoke', { label }))) return
  try {
    await window.api.revokeToken(id)
    window.showToast(t('mobile.settings.tokens.toast.revoked'), 'success')
    await loadSettings()
  } catch { window.showToast(t('mobile.settings.toast.error'), 'error') }
}
