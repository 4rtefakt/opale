// Vue Paramètres — tokens, seuils, sync Intune, admins, audit
import { getLocale } from '/i18n.js'

let _data = null

export async function renderParametres(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('settings.title')}</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="reloadSettings()">
          <i class="ti ti-refresh"></i> ${t('settings.btn.refresh')}
        </button>
      </div>
    </div>
    <div id="settings-body" style="flex:1;overflow-y:auto;padding:20px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

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

  await reloadSettings()
}

async function reloadSettings() {
  const body = document.getElementById('settings-body')
  try {
    _data = await window.api.getSettings()
    render()
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><i class="ti ti-lock"></i><p>${t('error.forbidden')}</p></div>`
  }
}

function render() {
  const body = document.getElementById('settings-body')
  const s    = _data.settings

  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:24px">
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
                <button class="btn btn-sm" onclick="deleteSSHKey('${k.id}','${esc(k.label)}')"
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
                  <button class="btn btn-sm" onclick="revokeToken('${tk.id}','${esc(tk.label)}')"
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
                  <button class="btn btn-sm" onclick="revokeCliToken('${tk.id}','${esc(tk.label)}')"
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
            <button class="btn btn-sm" onclick="revokeAdmin('${esc(u.entra_id)}')"
              style="color:var(--red);flex-shrink:0">
              <i class="ti ti-x"></i> ${t('settings.admins.btn.revoke')}
            </button>
          </div>`).join('')
      })()}
    </div>

  </div>`
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
            <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${esc(tk.token)}').then(()=>showToast('Copié','success'))">
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
                onclick="window._addAdmin('${u.entra_id}')">
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

