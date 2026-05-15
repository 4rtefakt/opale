// Vue Alertes — sections par type, snoozés relégués en bas et grisés.
// Mapping section ↔ alert_type côté DB (cohérent avec api/routes/alert-snoozes.js) :
const TYPE_BY_SECTION = {
  disk_critical: 'disk_critical',
  disk_warn:     'disk_high',
  non_compliant: 'noncompliant',
  offline:       'offline',
}

export async function renderAlertes(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('alertes.title')}</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="alertesReload()">
          <i class="ti ti-refresh"></i> ${t('settings.btn.refresh')}
        </button>
      </div>
    </div>
    <div id="alertes-body" style="flex:1;overflow-y:auto;padding:20px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  window.alertesReload = load
  await load()
}

async function load() {
  const body = document.getElementById('alertes-body')
  if (!body) return
  try {
    const data = await window.api.getAlerts()
    render(body, data)
  } catch {
    body.innerHTML = `<div class="empty-state"><p>${t('error.generic')}</p></div>`
  }
}

function render(body, data) {
  const total = data.counts.critical + data.counts.warn
  const snoozedTotal = (data.disk_critical || []).filter(r => r.snoozed_until).length
                     + (data.disk_warn     || []).filter(r => r.snoozed_until).length
                     + (data.non_compliant || []).filter(r => r.snoozed_until).length
                     + (data.offline       || []).filter(r => r.snoozed_until).length

  if (!total && !snoozedTotal) {
    body.innerHTML = `
      <div class="empty-state" style="height:100%;justify-content:center">
        <i class="ti ti-circle-check" style="font-size:48px;color:var(--green)"></i>
        <p style="font-size:15px;font-weight:500">${t('alertes.all_clear')}</p>
        <p style="font-size:12px;color:var(--text-tertiary)">${t('alertes.all_clear_sub')}</p>
      </div>`
    return
  }

  const sections = [
    {
      key:     'disk_critical',
      icon:    'ti-device-laptop',
      color:   'var(--red)',
      bgColor: 'var(--red-bg)',
      rows:    data.disk_critical,
      render:  r => `${esc(r.hostname)} <span style="color:var(--text-tertiary)">·</span> <b style="color:var(--red)">${r.disk_used_pct}%</b>${r.user_name ? ` <span style="color:var(--text-tertiary)">· ${esc(r.user_name)}</span>` : ''}`,
    },
    {
      key:     'non_compliant',
      icon:    'ti-shield-off',
      color:   'var(--red)',
      bgColor: 'var(--red-bg)',
      rows:    data.non_compliant,
      render:  r => `${esc(r.hostname)} <span style="color:var(--text-tertiary)">·</span> <span style="color:var(--red)">${esc(r.compliance_state)}</span>${r.user_name ? ` <span style="color:var(--text-tertiary)">· ${esc(r.user_name)}</span>` : ''}`,
    },
    {
      key:     'disk_warn',
      icon:    'ti-device-laptop',
      color:   'var(--amber)',
      bgColor: 'var(--amber-bg)',
      rows:    data.disk_warn,
      render:  r => `${esc(r.hostname)} <span style="color:var(--text-tertiary)">·</span> <b style="color:var(--amber)">${r.disk_used_pct}%</b>${r.user_name ? ` <span style="color:var(--text-tertiary)">· ${esc(r.user_name)}</span>` : ''}`,
    },
    {
      key:     'offline',
      icon:    'ti-wifi-off',
      color:   'var(--text-tertiary)',
      bgColor: 'var(--bg-secondary)',
      rows:    data.offline,
      render:  r => `${esc(r.hostname)} <span style="color:var(--text-tertiary)">·</span> ${t('alertes.last_seen')} ${formatRelative(r.last_seen)}${r.user_name ? ` <span style="color:var(--text-tertiary)">· ${esc(r.user_name)}</span>` : ''}`,
    },
  ]

  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">${
    sections.filter(s => s.rows.length).map(s => {
      const active  = s.rows.filter(r => !r.snoozed_until)
      const snoozed = s.rows.filter(r =>  r.snoozed_until)
      const alertType = TYPE_BY_SECTION[s.key]
      return `
        <div class="panel">
          <div class="panel-header" style="color:${s.color}">
            <i class="ti ${s.icon}"></i> ${t('alertes.section.' + s.key)}
            <span class="badge" style="background:${s.bgColor};color:${s.color};margin-left:4px">${active.length}</span>
            ${snoozed.length ? `<span class="badge" style="background:var(--bg-secondary);color:var(--text-tertiary);margin-left:4px"><i class="ti ti-zzz"></i> ${snoozed.length}</span>` : ''}
          </div>
          <div>
            ${active.map(r => alertRow(r, s, alertType, false)).join('')}
            ${snoozed.map(r => alertRow(r, s, alertType, true)).join('')}
          </div>
        </div>`
    }).join('')
  }</div>`
}

function alertRow(r, s, alertType, isSnoozed) {
  const opacity = isSnoozed ? 0.5 : 1
  const snoozeInfo = isSnoozed
    ? `<span style="font-size:11px;color:var(--text-tertiary);font-style:italic">${t('alertes.snooze.until')} ${formatRelative(r.snoozed_until)}</span>`
    : ''
  const actionBtn = isSnoozed
    ? `<button class="btn btn-sm" onclick="alUnsnooze('${esc(r.id)}','${esc(alertType)}')" title="${t('alertes.snooze.unsnooze')}"><i class="ti ti-bell-ringing"></i></button>`
    : `<button class="btn btn-sm" onclick="alOpenSnooze('${esc(r.id)}','${esc(alertType)}',${jsArg(r.hostname)})" title="${t('alertes.snooze.btn')}"><i class="ti ti-zzz"></i></button>`
  // Ne navigue que si le clic n'est pas sur un bouton (snooze/réveil) — robuste
  // même quand l'event part d'un <i> enfant du bouton.
  return `
    <div class="alert-row" onclick="if(!event.target.closest('button'))navigateTo('/postes/${esc(r.id)}')" style="border-left:3px solid ${s.color};opacity:${opacity}">
      <i class="ti ${s.icon}" style="color:${s.color};flex-shrink:0"></i>
      <span style="font-size:13px;flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${s.render(r)}
        ${snoozeInfo}
      </span>
      ${actionBtn}
      <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px"></i>
    </div>`
}

// jsArg() fourni globalement par app.js (window.jsArg)

// ─── Snooze : modal + actions ───
window.alOpenSnooze = function(deviceId, alertType, hostname) {
  showModal(`
    <div class="modal-title">${t('alertes.snooze.title')} — ${esc(hostname)}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${[1,3,7,14,30].map(d => `<button class="btn btn-sm" onclick="window.alPickPreset(${d})">${t('alertes.snooze.preset.' + d + 'd')}</button>`).join('')}
      </div>
      <input class="form-input" id="al-snooze-reason" placeholder="${t('alertes.snooze.reason')}" autocomplete="off">
      <div style="font-size:11px;color:var(--text-tertiary)" id="al-snooze-preview"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('alertes.snooze.cancel')}</button>
      <button class="btn btn-primary" id="al-snooze-confirm" disabled onclick="window.alConfirmSnooze('${esc(deviceId)}','${esc(alertType)}')">${t('alertes.snooze.confirm')}</button>
    </div>
  `)
  window._alSnoozeUntil = null
}

window.alPickPreset = function(days) {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  window._alSnoozeUntil = until.toISOString()
  document.getElementById('al-snooze-preview').textContent =
    `${t('alertes.snooze.until')} ${until.toLocaleString()}`
  document.getElementById('al-snooze-confirm').disabled = false
}

window.alConfirmSnooze = async function(deviceId, alertType) {
  if (!window._alSnoozeUntil) return
  const reason = document.getElementById('al-snooze-reason')?.value?.trim() || null
  try {
    await window.api.createSnooze({
      device_id: deviceId,
      alert_type: alertType,
      until_at: window._alSnoozeUntil,
      reason
    })
    closeModal()
    showToast(t('alertes.snooze.toast.created'), 'success')
    await window.alertesReload()
  } catch (e) {
    showToast(e.message || t('error.generic'), 'error')
  }
}

window.alUnsnooze = async function(deviceId, alertType) {
  // On retrouve l'id du snooze actif via la liste pour faire le DELETE
  try {
    const list = await window.api.getSnoozes()
    const snz = list.find(s => s.device_id === deviceId && s.alert_type === alertType)
    if (!snz) return window.alertesReload()
    await window.api.deleteSnooze(snz.id)
    showToast(t('alertes.snooze.toast.removed'), 'success')
    await window.alertesReload()
  } catch (e) {
    showToast(e.message || t('error.generic'), 'error')
  }
}
