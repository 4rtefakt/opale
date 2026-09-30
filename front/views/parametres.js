// Vue Paramètres — tokens, seuils, sync Intune, admins, audit
import { getLocale } from '/i18n.js'
import { shortSha } from '/views/linux.js'

let _data = null

export async function renderParametres(container) {
  container.innerHTML = `
    <div class="page"><div class="page-inner">
      <div class="page-head">
        <div>
          <div class="page-kicker">${esc(t('settings.kicker'))}</div>
          <h1 class="page-h1">${esc(t('settings.title'))}</h1>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="reloadSettings()"><i class="ti ti-refresh"></i> ${t('settings.btn.refresh')}</button>
        </div>
      </div>
      <div class="seg settings-tabs" id="settings-tabs" style="display:none"></div>
      <div id="settings-body" class="stack">
        <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
      </div>
    </div></div>`

  window.reloadSettings      = reloadSettings
  window.createToken         = createToken
  window.revokeToken         = revokeToken
  window.saveThresholds      = saveThresholds
  window.saveSalary          = saveSalary
  window.saveBranding        = saveBranding
  window.saveAgentSettings   = saveAgentSettings
  window.saveComplianceAlerts = saveComplianceAlerts
  window.showNewSSHKeyModal  = showNewSSHKeyModal
  window.addSSHKey           = addSSHKey
  window.deleteSSHKey        = deleteSSHKey
  window.syncIntune          = syncIntune
  window.syncAllUsers        = syncAllUsers
  window.revokeCliToken      = revokeCliToken
  window.revokeAdmin         = revokeAdmin
  window.showAddAdminModal   = showAddAdminModal
  window.showNewTokenModal   = showNewTokenModal
  window.pickTheme           = pickTheme
  window.settingsTab         = settingsTab
  window.linuxSaveSettings   = linuxSaveSettings
  window.linuxSaveAlerts     = linuxSaveAlerts
  window.linuxSyncNow        = linuxSyncNow
  window.linuxPromote        = linuxPromote
  window.linuxConfirmBackup  = linuxConfirmBackup
  window.linuxReloadSettings = loadLinuxSettings

  await reloadSettings()
}

async function reloadSettings() {
  const body = document.getElementById('settings-body')
  try {
    _data = await window.api.getSettings()
    _linux = null   // « Actualiser » recharge aussi la section Linux (sinon servie depuis le cache)
    render()
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><i class="ti ti-lock"></i><p>${t('error.forbidden')}</p></div>`
  }
}

function render() {
  const body = document.getElementById('settings-body')
  const s    = _data.settings
  setTimeout(paintSettingsMode, 0)

  body.style.gap = '20px'
  renderTabs()
  body.innerHTML = `
    <section class="settings-tab" data-tab="appearance">
    <!-- Langue -->
    <div class="panel">
      <div class="panel-header">${t('settings.language.title')}</div>
      <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:12px;color:var(--text-secondary)">${t('settings.language.desc')}</span>
        <div style="display:flex;gap:8px;margin-left:auto">
          <button class="btn ${getLocale()==='fr' ? 'btn-primary' : ''}" onclick="setLocale('fr')">🇫🇷 Français</button>
          <button class="btn ${getLocale()==='en' ? 'btn-primary' : ''}" onclick="setLocale('en')">🇬🇧 English</button>
        </div>
      </div>
    </div>

    <!-- Apparence : thème + mode clair/sombre (préférence par utilisateur) -->
    <div class="panel">
      <div class="panel-header">${t('settings.appearance.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.appearance.desc')}</p>
        <div class="theme-grid" id="theme-grid">${renderThemeCards()}</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-secondary)">${t('settings.appearance.mode')}</span>
          <div class="seg" id="settings-mode-seg">
            <button class="seg-btn" data-mode="system" onclick="setThemeMode('system')"><i class="ti ti-device-desktop"></i> ${t('settings.appearance.mode.system')}</button>
            <button class="seg-btn" data-mode="light"  onclick="setThemeMode('light')"><i class="ti ti-sun"></i> ${t('settings.appearance.mode.light')}</button>
            <button class="seg-btn" data-mode="dark"   onclick="setThemeMode('dark')"><i class="ti ti-moon"></i> ${t('settings.appearance.mode.dark')}</button>
          </div>
          <span style="font-size:11px;color:var(--text-tertiary)">${t('settings.appearance.sync_note')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-secondary)">${t('settings.appearance.motion')}</span>
          <div class="seg" id="settings-motion-seg">
            <button class="seg-btn" data-motion="full" onclick="setThemeMotion('full')"><i class="ti ti-sparkles"></i> ${t('settings.appearance.motion.full')}</button>
            <button class="seg-btn" data-motion="reduced" onclick="setThemeMotion('reduced')"><i class="ti ti-eye-off"></i> ${t('settings.appearance.motion.reduced')}</button>
          </div>
          <span style="font-size:11px;color:var(--text-tertiary)">${t('settings.appearance.motion_hint')}</span>
        </div>
      </div>
    </div>

    </section>
    <section class="settings-tab" data-tab="instance">
    <!-- Branding (nom, tagline, filtre Graph) -->
    <div class="panel">
      <div class="panel-header">${t('settings.branding.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:16px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.branding.desc')}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div class="form-row">
            <label class="form-label">${t('settings.branding.org_name')}</label>
            <input class="form-input" id="brand-org-name" type="text" maxlength="80"
              value="${esc(s['org.name'] || '')}" placeholder="Your Organization">
          </div>
          <div class="form-row">
            <label class="form-label">${t('settings.branding.product_name')}</label>
            <input class="form-input" id="brand-product-name" type="text" maxlength="60"
              value="${esc(s['app.product_name'] || '')}" placeholder="Opale">
          </div>
          <div class="form-row">
            <label class="form-label">${t('settings.branding.tagline')}</label>
            <input class="form-input" id="brand-tagline" type="text" maxlength="120"
              value="${esc(s['app.tagline'] || '')}" placeholder="Open RMM platform">
          </div>
          <div class="form-row">
            <label class="form-label">${t('settings.branding.role_label')}</label>
            <input class="form-input" id="brand-role" type="text" maxlength="32"
              value="${esc(s['app.default_role_label'] || '')}" placeholder="IT">
          </div>
        </div>
        <div style="border-top:0.5px solid var(--border);padding-top:14px">
          <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">${t('settings.branding.users_filter_desc')}</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
            <div class="form-row">
              <label class="form-label">${t('settings.branding.users_filter_attr')}</label>
              <input class="form-input" id="brand-filter-attr" type="text" maxlength="64"
                value="${esc(s['users.filter_attribute'] || '')}" placeholder="extensionAttribute1">
            </div>
            <div class="form-row">
              <label class="form-label">${t('settings.branding.users_filter_value')}</label>
              <input class="form-input" id="brand-filter-value" type="text" maxlength="128"
                value="${esc(s['users.filter_value'] || '')}" placeholder="Salarie">
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-primary" onclick="saveBranding()">
            <i class="ti ti-device-floppy"></i> ${t('settings.btn.save')}
          </button>
          <span style="font-size:11px;color:var(--text-tertiary)">${t('settings.branding.reload_note')}</span>
        </div>
      </div>
    </div>

    <!-- Seuils d'alerte -->
    <div class="panel">
      <div class="panel-header">${t('settings.thresholds.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:16px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.thresholds.desc')}</p>
        <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-row" style="width:180px">
            <label class="form-label">${t('settings.thresholds.warn')} (%)</label>
            <input class="form-input" id="thr-warn" type="number" min="50" max="99"
              value="${esc(s.disk_warn_pct || '80')}">
          </div>
          <div class="form-row" style="width:180px">
            <label class="form-label">${t('settings.thresholds.critical')} (%)</label>
            <input class="form-input" id="thr-crit" type="number" min="50" max="99"
              value="${esc(s.disk_critical_pct || '90')}">
          </div>
          <div class="form-row" style="width:180px">
            <label class="form-label">${t('settings.thresholds.offline_days')}</label>
            <input class="form-input" id="thr-offline" type="number" min="1" max="365"
              value="${esc(s.agent_offline_days || '7')}">
          </div>
          <button class="btn btn-primary" onclick="saveThresholds()" style="margin-bottom:1px">
            <i class="ti ti-device-floppy"></i> ${t('settings.btn.save')}
          </button>
        </div>
      </div>
    </div>

    <!-- Conformité — toggle alertes auto (push + ticket_proposal) -->
    <div class="panel">
      <div class="panel-header">${t('settings.compliance.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.compliance.desc')}</p>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" id="compliance-alerts-toggle"
                 ${s.compliance_alerts_enabled === 'true' ? 'checked' : ''}
                 onchange="saveComplianceAlerts(this.checked)">
          <label for="compliance-alerts-toggle" style="font-size:13px;cursor:pointer;user-select:none">
            ${t('settings.compliance.alerts_label')}
          </label>
        </div>
        <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border-left:3px solid var(--blue,var(--text-tertiary));border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);line-height:1.55">
          <i class="ti ti-info-circle" style="margin-top:2px;flex-shrink:0"></i>
          <div>${t('settings.compliance.alerts_hint')}</div>
        </div>
      </div>
    </div>

    <!-- Coût admin (pour le calcul du temps épargné dans Rapports) -->
    <div class="panel">
      <div class="panel-header">${t('settings.salary.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.salary.desc')}</p>
        <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-row" style="width:180px">
            <label class="form-label">${t('settings.salary.label')}</label>
            <input class="form-input" id="cost-per-hour" type="number" min="0" step="0.5"
              value="${esc(s.cost_per_hour || '22.54')}">
          </div>
          <button class="btn btn-primary" onclick="saveSalary()" style="margin-bottom:1px">
            <i class="ti ti-device-floppy"></i> ${t('settings.btn.save')}
          </button>
        </div>
      </div>
    </div>

    </section>
    <section class="settings-tab" data-tab="integrations">
    <!-- Sync Intune -->
    <div class="panel">
      <div class="panel-header">${t('settings.intune.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.intune.desc')}</p>
        <div style="display:flex;gap:12px;align-items:center">
          <button class="btn btn-primary" id="btn-sync-intune" onclick="syncIntune()">
            <i class="ti ti-cloud-download"></i> ${t('settings.intune.btn')}
          </button>
          <span id="sync-result" style="font-size:12px;color:var(--text-tertiary)"></span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">Synchronisation utilisateurs Entra</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">Importe tous les membres Entra (userType=Member, accountEnabled) dans le cache local. Utile pour résoudre les utilisateurs affichés en UUID dans les groupes.</p>
        <div style="display:flex;gap:12px;align-items:center">
          <button class="btn btn-primary" id="btn-sync-users" onclick="syncAllUsers()">
            <i class="ti ti-users"></i> Synchroniser les utilisateurs
          </button>
          <span id="sync-users-result" style="font-size:12px;color:var(--text-tertiary)"></span>
        </div>
      </div>
    </div>

    </section>
    <section class="settings-tab" data-tab="security">
    <!-- Clés SSH publiques -->
    <div class="panel">
      <div class="panel-header">
        Clés SSH publiques
        <button class="btn btn-primary btn-sm" onclick="showNewSSHKeyModal()">
          <i class="ti ti-plus"></i> Ajouter
        </button>
      </div>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0;padding:12px 16px">Clés déployées sur les machines Windows via l'agent (fichier <code>administrators_authorized_keys</code>).</p>
      <table class="table">
        <thead><tr>
          <th>Label</th>
          <th>Clé publique</th>
          <th>Ajoutée</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${_data.ssh_keys?.length ? _data.ssh_keys.map(k => `
            <tr>
              <td style="font-weight:500">${esc(k.label)}</td>
              <td style="font-family:monospace;font-size:11px;color:var(--text-secondary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  title="${esc(k.public_key)}">${esc(k.public_key)}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${formatRelative(k.created_at)}${k.created_by ? ` · ${esc(k.created_by)}` : ''}</td>
              <td style="text-align:right">
                <button class="btn btn-sm" onclick="deleteSSHKey('${k.id}',${jsArg(k.label)})"
                  style="color:var(--red)">
                  <i class="ti ti-trash"></i>
                </button>
              </td>
            </tr>`).join('')
            : `<tr><td colspan="4"><div class="empty-state" style="padding:1.5rem"><p>Aucune clé SSH configurée</p></div></td></tr>`}
        </tbody>
      </table>
    </div>

    <!-- Agent — paramètres runtime lus par l'agent Go au checkin -->
    <div class="panel">
      <div class="panel-header">${t('settings.agent.title')}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${t('settings.agent.desc')}</p>
        <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-row" style="width:280px">
            <label class="form-label">${t('settings.agent.laps_user_label')}</label>
            <input class="form-input" id="agent-laps-user" type="text" maxlength="32"
              pattern="[A-Za-z0-9_.\\-]+" autocomplete="off"
              value="${esc(s['agent.laps_recovery_username'] || '')}"
              placeholder="opale-recovery">
          </div>
          <button class="btn btn-primary" onclick="saveAgentSettings()" style="margin-bottom:1px">
            <i class="ti ti-device-floppy"></i> ${t('settings.btn.save')}
          </button>
        </div>
        <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border-left:3px solid var(--orange);border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);line-height:1.55">
          <i class="ti ti-alert-triangle" style="color:var(--orange);margin-top:2px;flex-shrink:0"></i>
          <div>${t('settings.agent.laps_user_warning')}</div>
        </div>
      </div>
    </div>

    <!-- Tokens agent -->
    <div class="panel">
      <div class="panel-header">
        ${t('settings.tokens.title')}
        <button class="btn btn-primary btn-sm" onclick="showNewTokenModal()">
          <i class="ti ti-plus"></i> ${t('settings.tokens.btn.new')}
        </button>
      </div>
      <div id="token-new-reveal" style="display:none;padding:10px 16px;margin-bottom:8px;border-bottom:0.5px solid var(--border)"></div>
      <table class="table">
        <thead><tr>
          <th>${t('settings.tokens.col.label')}</th>
          <th>${t('settings.tokens.col.device')}</th>
          <th>${t('settings.tokens.col.created')}</th>
          <th>${t('settings.tokens.col.last_used')}</th>
          <th>${t('settings.tokens.col.status')}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${_data.tokens.length ? _data.tokens.map(tk => `
            <tr class="${tk.revoked_at ? 'tr-muted' : ''}">
              <td style="font-weight:500">${esc(tk.label)}</td>
              <td style="color:var(--text-tertiary)">${esc(tk.hostname || '—')}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${formatRelative(tk.created_at)}${tk.created_by ? ` · ${esc(tk.created_by)}` : ''}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${tk.last_used_at ? formatRelative(tk.last_used_at) : '—'}</td>
              <td>${tk.revoked_at
                ? `<span class="badge badge-red">${t('settings.tokens.revoked')}</span>`
                : `<span class="badge badge-green">${t('settings.tokens.active')}</span>`}</td>
              <td style="text-align:right">
                ${!tk.revoked_at ? `
                  <button class="btn btn-sm" onclick="revokeToken('${tk.id}',${jsArg(tk.label)})"
                    style="color:var(--red)">
                    <i class="ti ti-ban"></i> ${t('settings.tokens.btn.revoke')}
                  </button>` : ''}
              </td>
            </tr>`).join('')
            : `<tr><td colspan="6"><div class="empty-state" style="padding:1.5rem"><p>${t('settings.tokens.empty')}</p></div></td></tr>`}
        </tbody>
      </table>
    </div>

    <!-- Tokens CLI -->
    <div class="panel">
      <div class="panel-header">${t('settings.cli_tokens.title')}</div>
      <table class="table">
        <thead><tr>
          <th>${t('settings.cli_tokens.col.label')}</th>
          <th>${t('settings.cli_tokens.col.owner')}</th>
          <th>${t('settings.cli_tokens.col.created')}</th>
          <th>${t('settings.cli_tokens.col.expires')}</th>
          <th>${t('settings.cli_tokens.col.last_used')}</th>
          <th>${t('settings.tokens.col.status')}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${_data.cli_tokens?.length ? _data.cli_tokens.map(tk => `
            <tr class="${tk.revoked_at ? 'tr-muted' : ''}">
              <td style="font-weight:500">${esc(tk.label)}</td>
              <td style="color:var(--text-tertiary)">${esc(tk.owner_name || tk.entra_id)}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${formatRelative(tk.created_at)}${tk.created_by ? ` · ${esc(tk.created_by)}` : ''}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${tk.expires_at ? formatRelative(tk.expires_at) : '—'}</td>
              <td style="font-size:12px;color:var(--text-tertiary)">${tk.last_used_at ? formatRelative(tk.last_used_at) : '—'}</td>
              <td>${tk.revoked_at
                ? `<span class="badge badge-red">${t('settings.tokens.revoked')}</span>`
                : `<span class="badge badge-green">${t('settings.tokens.active')}</span>`}</td>
              <td style="text-align:right">
                ${!tk.revoked_at ? `
                  <button class="btn btn-sm" onclick="revokeCliToken('${tk.id}',${jsArg(tk.label)})"
                    style="color:var(--red)">
                    <i class="ti ti-ban"></i> ${t('settings.tokens.btn.revoke')}
                  </button>` : ''}
              </td>
            </tr>`).join('')
            : `<tr><td colspan="7"><div class="empty-state" style="padding:1.5rem"><p>${t('settings.cli_tokens.empty')}</p></div></td></tr>`}
        </tbody>
      </table>
    </div>

    <!-- Administrateurs -->
    <div class="panel">
      <div class="panel-header">
        ${t('settings.admins.title')}
        <button class="btn btn-primary btn-sm" onclick="showAddAdminModal()">
          <i class="ti ti-plus"></i> ${t('settings.admins.btn.add')}
        </button>
      </div>
      ${(() => {
        const admins = _data.admins.filter(u => u.is_admin)
        if (!admins.length) return `<div class="empty-state" style="padding:24px"><p>${t('settings.admins.empty')}</p></div>`
        return admins.map(u => `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:0.5px solid var(--border)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500">${esc(u.display_name || '—')}</div>
              <div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email || '—')}</div>
            </div>
            <button class="btn btn-sm" onclick="revokeAdmin(${jsArg(u.entra_id)})"
              style="color:var(--red);flex-shrink:0">
              <i class="ti ti-x"></i> ${t('settings.admins.btn.revoke')}
            </button>
          </div>`).join('')
      })()}
    </div>
    </section>
    ${LINUX_ENABLED ? `<section class="settings-tab" data-tab="linux" id="settings-linux">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </section>` : ''}`
  applyTab()
  // Section Linux chargée à la demande (4 GET) : repeinte depuis le cache si
  // déjà chargée, sinon seulement quand son onglet est visible.
  if (LINUX_ENABLED) {
    if (_linux) renderLinuxSettings()
    else if (_tab === 'linux') loadLinuxSettings()
  }
}

// Onglets : une seule famille de réglages à l'écran à la fois (mémorisé).
const LINUX_ENABLED = window.OPALE.moduleEnabled('linux')
const SETTINGS_TABS = ['appearance', 'instance', 'integrations', 'security', ...(LINUX_ENABLED ? ['linux'] : [])]
let _tab = SETTINGS_TABS.includes(localStorage.getItem('settings-tab')) ? localStorage.getItem('settings-tab') : 'appearance'
function renderTabs() {
  const el = document.getElementById('settings-tabs')
  if (!el) return
  el.style.display = ''
  el.innerHTML = SETTINGS_TABS.map(k => `<button class="seg-btn ${k === _tab ? 'active' : ''}" data-tab="${k}" onclick="settingsTab('${k}')">${esc(t('settings.tab.' + k))}</button>`).join('')
}
function settingsTab(k) {
  if (!SETTINGS_TABS.includes(k)) return
  _tab = k
  localStorage.setItem('settings-tab', k)
  document.querySelectorAll('#settings-tabs .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === k))
  applyTab()
  if (k === 'linux' && !_linux) loadLinuxSettings()
  document.getElementById('settings-body')?.closest('.page')?.scrollTo({ top: 0 })
}
function applyTab() {
  document.querySelectorAll('#settings-body .settings-tab').forEach(sec => { sec.style.display = sec.dataset.tab === _tab ? '' : 'none' })
}

async function saveBranding() {
  const payload = {
    'org.name':              document.getElementById('brand-org-name')?.value?.trim()    ?? '',
    'app.product_name':      document.getElementById('brand-product-name')?.value?.trim() ?? '',
    'app.tagline':           document.getElementById('brand-tagline')?.value?.trim()      ?? '',
    'app.default_role_label':document.getElementById('brand-role')?.value?.trim()         ?? '',
    'users.filter_attribute':document.getElementById('brand-filter-attr')?.value?.trim()  ?? '',
    'users.filter_value':    document.getElementById('brand-filter-value')?.value?.trim() ?? '',
  }
  // Filtre Graph : les deux clés doivent être présentes ensemble (sinon le
  // filtre OData côté graph.js l'ignore — pas une erreur, mais on prévient
  // l'admin pour éviter la confusion silencieuse).
  if (Boolean(payload['users.filter_attribute']) !== Boolean(payload['users.filter_value'])) {
    showToast(t('settings.branding.users_filter_partial'), 'error')
    return
  }
  try {
    await window.api.updateSettings(payload)
    showToast(t('settings.branding.toast.saved'), 'success')
    // Reload pour rafraîchir window.ENV.BRANDING (sidebar, login, manifest…).
    setTimeout(() => location.reload(), 600)
  } catch { showToast(t('error.generic'), 'error') }
}

async function saveAgentSettings() {
  const v = document.getElementById('agent-laps-user')?.value?.trim() || ''
  // Garde-fou client : empêche les noms d'admins critiques (l'agent Go a
  // déjà cette protection côté serveur, mais on évite le round-trip inutile).
  const banned = ['administrator', 'administrateur', 'admin', 'root', 'system']
  if (!v || banned.includes(v.toLowerCase())) {
    showToast(t('settings.agent.laps_user_error'), 'error')
    return
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(v)) {
    showToast(t('settings.agent.laps_user_error'), 'error')
    return
  }
  try {
    await window.api.updateSettings({ 'agent.laps_recovery_username': v })
    _data = await window.api.getSettings()
    render()
    showToast(t('settings.toast.saved'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function saveSalary() {
  const v = parseFloat(document.getElementById('cost-per-hour')?.value)
  if (isNaN(v) || v < 0) {
    showToast(t('error.generic'), 'error'); return
  }
  try {
    await window.api.updateSettings({ cost_per_hour: v })
    showToast(t('settings.toast.saved'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function saveThresholds() {
  const warn    = parseInt(document.getElementById('thr-warn')?.value, 10)
  const crit    = parseInt(document.getElementById('thr-crit')?.value, 10)
  const offline = parseInt(document.getElementById('thr-offline')?.value, 10)
  if (isNaN(warn) || isNaN(crit) || warn >= crit) {
    showToast(t('settings.thresholds.error'), 'error'); return
  }
  try {
    await window.api.updateSettings({ disk_warn_pct: warn, disk_critical_pct: crit, agent_offline_days: offline || 7 })
    showToast(t('settings.toast.saved'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

// Toggle pour `compliance_alerts_enabled` (table settings, lu par
// api/lib/compliance.js à chaque checkin). 'true'/'false' strict côté
// serveur — pas de booléen JSON. Save immédiat à chaque toggle (UX
// "switch flip" plutôt que bouton Save dédié).
async function saveComplianceAlerts(checked) {
  try {
    await window.api.updateSettings({ compliance_alerts_enabled: checked ? 'true' : 'false' })
    _data.settings.compliance_alerts_enabled = checked ? 'true' : 'false'
    showToast(t('settings.toast.saved'), 'success')
  } catch {
    showToast(t('error.generic'), 'error')
    // Rollback visuel : la save a échoué, on remet l'état visuel cohérent
    const el = document.getElementById('compliance-alerts-toggle')
    if (el) el.checked = !checked
  }
}

function showNewSSHKeyModal() {
  showModal(`
    <div class="modal-title">Ajouter une clé SSH publique</div>
    <div class="form-row">
      <label class="form-label">Label (ex: MacBook Clément)</label>
      <input class="form-input" id="new-sshkey-label" placeholder="Mon ordinateur">
    </div>
    <div class="form-row">
      <label class="form-label">Clé publique</label>
      <input class="form-input" id="new-sshkey-value" placeholder="ssh-ed25519 AAAA…"
        style="font-family:monospace;font-size:11px">
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="addSSHKey()"><i class="ti ti-plus"></i> Ajouter</button>
    </div>`)
}

async function addSSHKey() {
  const label      = document.getElementById('new-sshkey-label')?.value?.trim()
  const public_key = document.getElementById('new-sshkey-value')?.value?.trim()
  if (!label || !public_key) { showToast('Label et clé requis', 'error'); return }
  try {
    await window.api.addSSHKey({ label, public_key })
    closeModal()
    _data = await window.api.getSettings()
    render()
    showToast('Clé SSH ajoutée', 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function deleteSSHKey(id, label) {
  if (!confirm(`Supprimer la clé "${label}" ?\n\nLes machines ne se re-déploieront pas automatiquement.`)) return
  try {
    await window.api.deleteSSHKey(id)
    _data = await window.api.getSettings()
    render()
    showToast('Clé supprimée', 'info')
  } catch { showToast(t('error.generic'), 'error') }
}

async function syncIntune() {
  const btn = document.getElementById('btn-sync-intune')
  btn.disabled = true
  btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> ${t('settings.intune.syncing')}`
  try {
    const r = await window.api.syncIntune()
    showToast(t('settings.intune.ok', { n: r.upserted }), 'success')
    _data = await window.api.getSettings()
    render()
    // Mettre à jour le résultat dans le nouveau DOM
    const res = document.getElementById('sync-result')
    if (res) res.textContent = t('settings.intune.result', { upserted: r.upserted, errors: r.errors })
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  } finally {
    const b = document.getElementById('btn-sync-intune')
    if (b) { b.disabled = false; b.innerHTML = `<i class="ti ti-cloud-download"></i> ${t('settings.intune.btn')}` }
  }
}

async function syncAllUsers() {
  const btn = document.getElementById('btn-sync-users')
  btn.disabled = true
  btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Synchronisation…`
  try {
    const r = await window.api.syncAllUsers()
    showToast(`${r.synced} utilisateur(s) synchronisé(s)`, 'success')
    const res = document.getElementById('sync-users-result')
    if (res) res.textContent = `${r.synced} utilisateurs — ${new Date().toLocaleTimeString()}`
  } catch (err) {
    showToast(err.message || 'Erreur lors de la synchronisation', 'error')
  } finally {
    const b = document.getElementById('btn-sync-users')
    if (b) { b.disabled = false; b.innerHTML = `<i class="ti ti-users"></i> Synchroniser les utilisateurs` }
  }
}

function showNewTokenModal() {
  showModal(`
    <div class="modal-title">${t('settings.tokens.modal.title')}</div>
    <div class="form-row">
      <label class="form-label">${t('settings.tokens.modal.label')}</label>
      <input class="form-input" id="new-tok-label" placeholder="${t('settings.tokens.modal.placeholder')}">
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="createToken()">${t('btn.create')}</button>
    </div>`)
}

async function createToken() {
  const label = document.getElementById('new-tok-label')?.value?.trim()
  if (!label) { showToast(t('settings.tokens.modal.label_required'), 'error'); return }
  try {
    const tk = await window.api.createToken({ label })
    closeModal()
    // Afficher le token en clair une seule fois
    _data = await window.api.getSettings()
    render()
    // Révéler le token + bouton télécharger l'agent
    const reveal = document.getElementById('token-new-reveal')
    if (reveal) {
      reveal.style.display = 'block'
      reveal.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <i class="ti ti-key" style="color:var(--orange)"></i>
            <span style="font-size:12px;font-weight:500;color:var(--orange)">${t('settings.tokens.copy_once')}</span>
            <code id="plain-token" style="font-family:monospace;font-size:12px;background:var(--bg-tertiary);padding:4px 8px;border-radius:4px;word-break:break-all;flex:1">${esc(tk.token)}</code>
            <button class="btn btn-sm" onclick="navigator.clipboard.writeText(${jsArg(tk.token)}).then(()=>showToast('Copié','success'))">
              <i class="ti ti-copy"></i>
            </button>
          </div>
          <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);line-height:1.5">
            <i class="ti ti-info-circle" style="color:var(--blue);margin-top:2px"></i>
            <div>
              Pour générer l'installeur agent, exécutez côté serveur :<br>
              <code style="display:inline-block;margin-top:4px">TOKEN=${esc(tk.token)} URL=&lt;url-rmm&gt; node agent-go/build.js</code>
            </div>
          </div>
        </div>`
      setTimeout(() => { if (reveal) reveal.style.display = 'none' }, 120_000)
    }
    showToast(t('settings.tokens.toast.created'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function revokeToken(id, label) {
  if (!confirm(t('settings.tokens.confirm_revoke', { label }))) return
  try {
    await window.api.revokeToken(id)
    _data = await window.api.getSettings()
    render()
    showToast(t('settings.tokens.toast.revoked'), 'info')
  } catch { showToast(t('error.generic'), 'error') }
}

async function revokeCliToken(id, label) {
  if (!confirm(t('settings.cli_tokens.confirm_revoke', { label }))) return
  try {
    await window.api.revokeCliToken(id)
    _data = await window.api.getSettings()
    render()
    showToast(t('settings.cli_tokens.toast.revoked'), 'info')
  } catch { showToast(t('error.generic'), 'error') }
}

async function revokeAdmin(entraId) {
  try {
    await window.api.setAdmin(entraId, false)
    const idx = _data.admins.findIndex(u => u.entra_id === entraId)
    if (idx !== -1) _data.admins[idx].is_admin = false
    render()
    showToast(t('settings.admins.toast.revoked'), 'info')
  } catch { showToast(t('error.generic'), 'error'); reloadSettings() }
}

async function showAddAdminModal() {
  showModal(`
    <div class="modal-title">${t('settings.admins.modal.title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="admin-search-q" placeholder="${t('settings.admins.search')}" autocomplete="off">
      <div id="admin-search-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)

  const input = document.getElementById('admin-search-q')
  const list  = document.getElementById('admin-search-results')
  setTimeout(() => input?.focus(), 50)

  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        list.innerHTML = users.length
          ? users.map(u => `
              <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                onclick="window._addAdmin(${jsArg(u.entra_id)})">
                <div style="font-size:13px">${esc(u.display_name)}</div>
                ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
              </div>`).join('')
          : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('settings.admins.no_match')}</div>`
      } catch { list.innerHTML = '' }
    }, 200)
  })

  window._addAdmin = async (entraId) => {
    if (_data.admins.find(u => u.entra_id === entraId && u.is_admin)) {
      showToast(t('settings.admins.toast.already_admin'), 'info')
      return
    }
    closeModal()
    try {
      await window.api.setAdmin(entraId, true)
      _data = await window.api.getSettings()
      render()
      showToast(t('settings.admins.toast.granted'), 'success')
    } catch { showToast(t('error.generic'), 'error') }
  }
}

// ── Apparence ────────────────────────────────────────────────────────────────

function renderThemeCards() {
  const T = window.OpaleTheme
  if (!T) return ''
  const { theme: current, scheme } = T.get()
  return Object.entries(T.THEMES).map(([id, th]) => {
    const p = th[scheme] || th.light
    return `
      <button class="theme-card ${id === current ? 'active' : ''}" onclick="pickTheme('${id}')" type="button">
        <div class="theme-preview" style="background:${th.preview ? th.preview : p['bg-primary']}">
          <div class="tp-side" style="background:${p['sidebar-bg']}">
            <i style="background:${p['primary']};opacity:1"></i><i style="background:${p['text-tertiary']}"></i><i style="background:${p['text-tertiary']}"></i>
          </div>
          <div class="tp-main">
            <i style="background:${p['text-primary']};width:60%"></i>
            <i style="background:${p['bg-tertiary']};width:85%"></i>
            <i style="background:${p['bg-tertiary']};width:70%"></i>
            <span class="tp-btn" style="background:${p['primary']}"></span>
          </div>
        </div>
        <div class="theme-name">${esc(th.label)}</div>
        <div class="theme-desc">${esc(th.desc)}</div>
      </button>`
  }).join('')
}

function paintSettingsMode() {
  const cur = window.OpaleTheme?.get() || {}
  document.querySelectorAll('#settings-mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === cur.mode))
  document.querySelectorAll('#settings-motion-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.motion === cur.motion))
  const grid = document.getElementById('theme-grid')
  if (grid) grid.innerHTML = renderThemeCards()
}
window.addEventListener('themechange', paintSettingsMode)

function pickTheme(id) {
  window.OpaleTheme?.save(window.api, { theme: id })
  showToast(t('settings.appearance.toast'), 'success')
}
window.setThemeMotion = (motion) => { window.OpaleTheme?.save(window.api, { motion }); paintSettingsMode() }

// ── Linux / état désiré ─────────────────────────────────────────────────────
// Dépôt de flotte (miroir git), signataires côté serveur, anneaux (branche
// amont, promotion de stable), alertes, clé d'escrow et confirmation de sa
// sauvegarde. Les écritures passent par PATCH /api/linux/settings avec les
// seuls champs modifiés.
let _linux = null   // { settings, git, rings, escrow }

async function loadLinuxSettings() {
  const el = document.getElementById('settings-linux')
  if (!el) return
  try {
    const [settings, git, rings, escrow] = await Promise.all([
      window.api.getLinuxSettings(), window.api.getLinuxGitStatus(), window.api.getLinuxRings(), window.api.getLinuxEscrowStatus(),
    ])
    _linux = { settings, git, rings, escrow }
    renderLinuxSettings()
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${esc(err.message || t('error.generic'))}</p><button class="btn" onclick="linuxReloadSettings()">${esc(t('settings.btn.refresh'))}</button></div>`
  }
}

const _mirrorBadge = state => {
  const cls = state === 'ready' ? 'badge-green' : state === 'stale' || state === 'cloning' ? 'badge-orange' : state === 'absent' ? 'badge-gray' : 'badge-red'
  return `<span class="badge ${cls}">${esc(t('settings.linux.mirror.' + state))}</span>`
}
const _signedBadge = signed => signed === null
  ? `<span class="badge badge-gray">${esc(t('settings.linux.rings.unverified'))}</span>`
  : signed ? `<span class="badge badge-green">${esc(t('settings.linux.rings.signed'))}</span>` : `<span class="badge badge-red">${esc(t('settings.linux.rings.unsigned'))}</span>`

function renderLinuxSettings() {
  const el = document.getElementById('settings-linux')
  if (!el || !_linux) return
  const { settings: s, git, rings, escrow } = _linux
  el.innerHTML = linuxRepoPanel(s, git) + linuxRingsPanel(s, rings) + linuxAlertsPanel(s) + linuxEscrowPanel(s, escrow)
}

// Re-rendu après une action ponctuelle (synchronisation, promotion, escrow)
// sans perdre les modifications non enregistrées des champs éditables.
function rerenderLinuxSettings() {
  const ids = ['linux-repo-url', 'linux-signers', 'linux-branch-pilot', 'linux-branch-stable']
  const edits = ids.map(id => [id, document.getElementById(id)?.value])
  renderLinuxSettings()
  for (const [id, value] of edits) {
    const input = document.getElementById(id)
    if (input && value !== undefined) input.value = value
  }
}

// Bouton d'enregistrement (diff seulement), répété sous chaque panneau éditable.
const linuxSaveRow = () => `
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-primary" onclick="linuxSaveSettings()"><i class="ti ti-device-floppy"></i> ${esc(t('settings.btn.save'))}</button>
          <span style="font-size:11px;color:var(--text-tertiary)">${esc(t('settings.linux.save_note'))}</span>
        </div>`

function linuxRepoPanel(s, git) {
  return `
    <!-- Dépôt de flotte -->
    <div class="panel">
      <div class="panel-header">${esc(t('settings.linux.repo.title'))}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('settings.linux.repo.desc'))}</p>
        <div class="form-row">
          <label class="form-label" for="linux-repo-url">${esc(t('settings.linux.repo.url'))}</label>
          <input class="form-input" id="linux-repo-url" type="url" maxlength="500" placeholder="https://git.example.org/it/fleet.git" value="${esc(s.repo_url || '')}">
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary)">
          ${_mirrorBadge(git.state)}
          <span>${esc(t('settings.linux.repo.last_fetch'))} ${esc(git.last_fetch_at ? formatRelative(git.last_fetch_at) : t('settings.linux.repo.never'))}</span>
          ${git.upstream ? `<span style="color:var(--text-tertiary);font-family:var(--font-mono,monospace);font-size:11px">${esc(git.upstream)}</span>` : ''}
          ${git.binaries_ok === false ? `<span class="badge badge-red">${esc(t('settings.linux.repo.binaries_missing'))}</span>` : ''}
          <button class="btn btn-sm" id="linux-sync-btn" onclick="linuxSyncNow()" style="margin-left:auto"><i class="ti ti-refresh"></i> ${esc(t('settings.linux.repo.sync'))}</button>
        </div>
        ${git.last_error ? `<div style="font-size:12px;color:var(--red);font-family:var(--font-mono,monospace);word-break:break-all">${esc(git.last_error)}</div>` : ''}
        <div class="form-row">
          <label class="form-label" for="linux-signers">${esc(t('settings.linux.signers.label'))}</label>
          <textarea class="form-textarea" id="linux-signers" rows="4" style="font-family:var(--font-mono,monospace);font-size:11px" placeholder="ops@example.org ssh-ed25519 AAAA…">${esc(s.allowed_signers.join('\n'))}</textarea>
          <span style="font-size:11px;color:var(--text-tertiary)">${esc(t('settings.linux.signers.hint'))}</span>
        </div>
        ${linuxSaveRow()}
      </div>
    </div>`
}

function linuxRingsPanel(s, rings) {
  const ringBlock = ring => {
    const r = rings[ring]
    return `
      <div style="border-top:0.5px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:600;min-width:60px">${esc(t('linux.queue.ring.' + ring))}</span>
          <div class="form-row" style="width:220px">
            <label class="form-label" for="linux-branch-${ring}">${esc(t('settings.linux.rings.branch'))}</label>
            <input class="form-input" id="linux-branch-${ring}" maxlength="200" value="${esc(s.rings[ring].branch)}">
          </div>
          <span style="font-size:12px;color:var(--text-secondary)">${esc(t('settings.linux.rings.tip'))} ${shortSha(r.tip)}${r.tip_since ? ` <span style="color:var(--text-tertiary)">${esc(t('settings.linux.rings.since', { when: formatRelative(r.tip_since) }))}</span>` : ''}${r.upstream_head && r.upstream_head !== r.tip ? ` · ${esc(t('settings.linux.rings.upstream'))} ${shortSha(r.upstream_head)}` : ''}</span>
          <span style="font-size:12px;color:var(--text-tertiary)">${esc(t('settings.linux.rings.devices', { total: r.devices.total, on_tip: r.devices.on_tip, lagging: r.devices.lagging, failed: r.devices.failed }))}</span>
        </div>
        ${ring === 'stable' ? (r.candidates.length ? `
          <div class="table-wrap"><table>
            <thead><tr>${['sha', 'subject', 'author', 'date', 'signed', 'success', 'actions'].map(k => `<th>${esc(t('settings.linux.rings.col.' + k))}</th>`).join('')}</tr></thead>
            <tbody>${r.candidates.map(c => `
              <tr class="${c.sha === r.tip ? 'selected' : ''}">
                <td>${shortSha(c.sha)}${c.sha === r.tip ? ` <span class="badge badge-blue">${esc(t('settings.linux.rings.current'))}</span>` : ''}${c.is_ancestor_of_stable ? ` <span class="badge badge-orange">${esc(t('settings.linux.rings.rollback'))}</span>` : ''}</td>
                <td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.subject)}">${esc(c.subject)}</td>
                <td style="font-size:12px;color:var(--text-secondary)">${esc(c.author)}</td>
                <td style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${esc(formatRelative(c.date))}</td>
                <td>${_signedBadge(c.signed)}</td>
                <td style="font-size:12px;white-space:nowrap">${esc(t('settings.linux.rings.success_counts', { pilot: c.success_pilot, stable: c.success_stable }))}</td>
                <td style="text-align:right">${c.sha === r.tip ? '' : `<button class="btn btn-sm btn-primary" onclick="linuxPromote(${jsArg(c.sha)})"><i class="ti ti-arrow-up-circle"></i> ${esc(t('settings.linux.rings.promote'))}</button>`}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : `<p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('settings.linux.rings.no_candidates'))}</p>`) : ''}
      </div>`
  }
  return `
    <!-- Anneaux -->
    <div class="panel">
      <div class="panel-header">${esc(t('settings.linux.rings.title'))} ${_mirrorBadge(rings.mirror_state)}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('settings.linux.rings.desc'))}</p>
        ${ringBlock('pilot')}
        ${ringBlock('stable')}
        ${linuxSaveRow()}
      </div>
    </div>`
}

function linuxAlertsPanel(s) {
  return `
    <!-- Alertes -->
    <div class="panel">
      <div class="panel-header">${esc(t('settings.linux.alerts.title'))}</div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" id="linux-alerts-toggle" ${s.alerts_enabled ? 'checked' : ''} onchange="linuxSaveAlerts(this.checked)">
          <label for="linux-alerts-toggle" style="font-size:13px;cursor:pointer;user-select:none">${esc(t('settings.linux.alerts.label'))}</label>
        </div>
        <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('settings.linux.alerts.hint'))}</p>
      </div>
    </div>`
}

function linuxEscrowPanel(s, escrow) {
  const backup = escrow.backup_confirmed && escrow.backup_confirmed.key_id === escrow.key_id ? escrow.backup_confirmed : null
  return `
    <!-- Escrow -->
    <div class="panel">
      <div class="panel-header">${esc(t('settings.linux.escrow.title'))}
        ${escrow.status === 'ok' ? `<span class="badge badge-green">${esc(t('settings.linux.escrow.ok'))}</span>` : `<span class="badge badge-red">${esc(t('settings.linux.escrow.unavailable'))}</span>`}
      </div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary)">
          <span>${esc(t('settings.linux.escrow.key_id'))} <code>${esc(escrow.key_id ? escrow.key_id.slice(0, 12) : '—')}</code></span>
          <span>${esc(t('settings.linux.escrow.bits'))} ${esc(escrow.bits ?? '—')}</span>
          <a href="#/linux?escrow=missing" class="nav-link" style="${escrow.devices_needing_escrow ? 'color:var(--red)' : ''}">${esc(t('settings.linux.escrow.needing', { n: escrow.devices_needing_escrow ?? 0 }))}</a>
          <span>${esc(t('settings.linux.escrow.local_admin', { user: s.local_admin_username }))}</span>
        </div>
        ${backup ? `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border-left:3px solid var(--green);border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);line-height:1.55">
            <i class="ti ti-shield-check" style="color:var(--green);margin-top:2px;flex-shrink:0"></i>
            <div>${esc(t('settings.linux.escrow.confirmed', { by: backup.by, when: formatRelative(backup.at) }))}</div>
          </div>` : `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-tertiary);border-left:3px solid var(--orange);border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);line-height:1.55">
            <i class="ti ti-alert-triangle" style="color:var(--orange);margin-top:2px;flex-shrink:0"></i>
            <div>
              <div style="font-weight:500;margin-bottom:6px">${esc(t('settings.linux.escrow.backup_title'))}</div>
              <ol style="margin:0 0 8px;padding-left:18px">
                <li>${esc(t('settings.linux.escrow.step1'))} <code>openssl rsa -in agent-go/keys/laps.key -check</code></li>
                <li>${esc(t('settings.linux.escrow.step2'))}</li>
                <li>${esc(t('settings.linux.escrow.step3'))}</li>
              </ol>
              <button class="btn btn-sm btn-primary" onclick="linuxConfirmBackup()" ${escrow.status === 'ok' && escrow.key_id ? '' : 'disabled'}><i class="ti ti-shield-check"></i> ${esc(t('settings.linux.escrow.confirm'))}</button>
            </div>
          </div>`}
      </div>
    </div>`
}

// Diff des champs modifiés seulement (repo_url, allowed_signers, rings.*.branch).
async function linuxSaveSettings() {
  if (!_linux) return
  const s = _linux.settings
  const patch = {}
  const url = document.getElementById('linux-repo-url')?.value.trim() ?? ''
  if (url !== (s.repo_url || '')) {
    if (!/^https:\/\/[^\s@/]+(\/[^\s]*)?$/.test(url)) { showToast(t('settings.linux.repo.url_error'), 'error'); return }
    patch.repo_url = url
  }
  const signers = (document.getElementById('linux-signers')?.value || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (JSON.stringify(signers) !== JSON.stringify(s.allowed_signers)) patch.allowed_signers = signers
  for (const ring of ['pilot', 'stable']) {
    const branch = document.getElementById(`linux-branch-${ring}`)?.value.trim()
    if (branch && branch !== s.rings[ring].branch) (patch.rings ??= {})[ring] = { branch }
  }
  if (!Object.keys(patch).length) { showToast(t('settings.linux.unchanged'), 'info'); return }
  try {
    _linux.settings = await window.api.updateLinuxSettings(patch)
    showToast(t('settings.toast.saved'), 'success')
    await loadLinuxSettings()
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function linuxSaveAlerts(checked) {
  try {
    _linux.settings = await window.api.updateLinuxSettings({ alerts_enabled: checked })
    showToast(t('settings.toast.saved'), 'success')
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
    const el = document.getElementById('linux-alerts-toggle')
    if (el) el.checked = !checked
  }
}

async function linuxSyncNow() {
  const btn = document.getElementById('linux-sync-btn')
  if (btn) btn.disabled = true
  try {
    _linux.git = await window.api.syncLinuxGit()
    showToast(t('settings.linux.repo.sync_started'), 'success')
    rerenderLinuxSettings()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
    if (btn) btn.disabled = false
  }
}

// Promotion de stable : confirmation avec la révision, case « retour arrière »
// seulement pour un ancêtre de la tête actuelle ; les 409 (NOT_ON_BRANCH,
// UNSIGNED, ROLLBACK, MIRROR_NOT_READY) sont affichés dans la modale.
function linuxPromote(sha) {
  const stable = _linux?.rings.stable
  const c = stable?.candidates.find(x => x.sha === sha)
  if (!c) return
  showModal(`
    <form id="linux-promote-form">
      <div class="modal-title">${esc(t('settings.linux.rings.promote_title'))}</div>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <div><code>${esc(sha.slice(0, 12))}</code> ${_signedBadge(c.signed)}</div>
        <div style="font-weight:500">${esc(c.subject)}</div>
        <div style="font-size:12px;color:var(--text-tertiary)">${esc(c.author)} · ${esc(formatRelative(c.date))} · ${esc(t('settings.linux.rings.success_counts', { pilot: c.success_pilot, stable: c.success_stable }))}</div>
        <p class="modal-sub" style="margin:4px 0 0">${esc(t('settings.linux.rings.promote_desc', { from: stable.tip ? stable.tip.slice(0, 7) : '—' }))}</p>
        ${c.is_ancestor_of_stable ? `<label style="display:flex;align-items:center;gap:8px;color:var(--orange)"><input type="checkbox" id="linux-promote-rollback"> ${esc(t('settings.linux.rings.allow_rollback'))}</label>` : ''}
        <p id="linux-promote-error" role="alert" style="color:var(--red);margin:0;font-size:12px"></p>
      </div>
      <div class="modal-footer"><button type="button" class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button><button type="submit" class="btn btn-primary">${esc(t('settings.linux.rings.promote'))}</button></div>
    </form>`)
  const form = document.getElementById('linux-promote-form')
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const button = form.querySelector('button[type=submit]')
    const error = form.querySelector('#linux-promote-error')
    button.disabled = true
    try {
      _linux.rings.stable = await window.api.promoteLinuxStable({ revision: sha, allow_rollback: !!form.querySelector('#linux-promote-rollback')?.checked })
      closeModal()
      showToast(t('settings.linux.rings.promoted', { sha: sha.slice(0, 7) }), 'success')
      rerenderLinuxSettings()
    } catch (err) {
      const code = err.body?.code
      const key = 'linux.code.' + code
      error.textContent = code && t(key) !== key ? t(key) : (err.message || t('error.generic'))
      button.disabled = false
    }
  })
}

async function linuxConfirmBackup() {
  const escrow = _linux?.escrow
  if (!escrow?.key_id) return
  if (!confirm(t('settings.linux.escrow.confirm_prompt', { key_id: escrow.key_id.slice(0, 12) }))) return
  try {
    _linux.escrow = await window.api.confirmLinuxEscrowBackup(escrow.key_id)
    showToast(t('settings.linux.escrow.confirmed_toast'), 'success')
    rerenderLinuxSettings()
  } catch (err) {
    const code = err.body?.code
    const key = 'linux.code.' + code
    showToast(code && t(key) !== key ? t(key) : (err.message || t('error.generic')), 'error')
    if (code === 'KEY_ID_MISMATCH') loadLinuxSettings()
  }
}
