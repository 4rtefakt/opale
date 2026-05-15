let _data   = null
let _filter = 'all'

export async function renderAlertes(el) {
  _filter = 'all'
  el.innerHTML = `
    <div class="m-header">
      <h1>${t('mobile.alertes.title')} <span id="m-al-count" style="font-size:12px;font-weight:400;color:var(--text-tertiary)"></span></h1>
      <button class="m-icon-btn" onclick="mAlLoad()">
        <i class="ti ti-refresh"></i>
      </button>
    </div>
    <div class="m-filters">
      <button class="m-filter-pill active" data-f="all"          onclick="mAlSetFilter('all',this)">${t('mobile.alertes.filter.all')}</button>
      <button class="m-filter-pill"        data-f="disk_critical" onclick="mAlSetFilter('disk_critical',this)">${t('mobile.alertes.filter.critical')}</button>
      <button class="m-filter-pill"        data-f="disk_warn"     onclick="mAlSetFilter('disk_warn',this)">${t('mobile.alertes.filter.warn')}</button>
      <button class="m-filter-pill"        data-f="offline"       onclick="mAlSetFilter('offline',this)">${t('mobile.alertes.filter.offline')}</button>
      <button class="m-filter-pill"        data-f="non_compliant" onclick="mAlSetFilter('non_compliant',this)">${t('mobile.alertes.filter.non_compliant')}</button>
    </div>
    <div class="m-scroll-list" id="m-al-list">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mAlLoad      = load
  window.mAlSetFilter = (f, btn) => {
    _filter = f
    el.querySelectorAll('.m-filter-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    renderList()
  }

  await load()
}

async function load() {
  const list = document.getElementById('m-al-list')
  if (!list) return
  list.innerHTML = `<div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>`
  try {
    _data = await window.api.getAlerts()
    renderList()
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function allAlerts() {
  if (!_data) return []
  const alerts = []

  ;(_data.disk_critical || []).forEach(d => alerts.push({
    type: 'disk_critical', id: d.id, hostname: d.hostname, user_name: d.user_name,
    message: t('mobile.alertes.msg.disk', { pct: d.disk_used_pct }),
    sub: d.user_name || '',
  }))
  ;(_data.disk_warn || []).forEach(d => alerts.push({
    type: 'disk_warn', id: d.id, hostname: d.hostname, user_name: d.user_name,
    message: t('mobile.alertes.msg.disk', { pct: d.disk_used_pct }),
    sub: d.user_name || '',
  }))
  ;(_data.offline || []).forEach(d => alerts.push({
    type: 'offline', id: d.id, hostname: d.hostname, user_name: d.user_name,
    message: d.last_seen
      ? t('mobile.alertes.msg.offline_since', { time: formatRelative(d.last_seen).replace('il y a ', '') })
      : t('mobile.alertes.msg.offline'),
    sub: d.user_name || '',
  }))
  ;(_data.non_compliant || []).forEach(d => alerts.push({
    type: 'non_compliant', id: d.id, hostname: d.hostname, user_name: d.user_name,
    message: d.compliance_state
      ? t('mobile.alertes.msg.non_compliant_state', { state: d.compliance_state })
      : t('mobile.alertes.msg.non_compliant'),
    sub: d.user_name || '',
  }))

  return alerts
}

function renderList() {
  const countEl = document.getElementById('m-al-count')
  const list    = document.getElementById('m-al-list')
  if (!list) return

  const all      = allAlerts()
  const filtered = _filter === 'all' ? all : all.filter(a => a.type === _filter)

  if (countEl) countEl.textContent = filtered.length ? `${filtered.length}` : ''

  if (!filtered.length) {
    list.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;padding:50px 20px;gap:10px">
        <i class="ti ti-shield-check" style="font-size:40px;color:var(--green);opacity:.6"></i>
        <div style="font-size:14px;font-weight:600;color:var(--text-secondary)">${t('mobile.alertes.empty')}</div>
        <div style="font-size:12px;color:var(--text-tertiary)">${t('mobile.alertes.empty_sub')}</div>
      </div>`
    return
  }

  list.innerHTML = filtered.map(a => {
    const isCrit = a.type === 'disk_critical'
    const isWarn = a.type === 'disk_warn'
    const isOff  = a.type === 'offline'

    const color   = isCrit ? 'var(--red)' : isWarn ? 'var(--amber)' : isOff ? 'var(--text-tertiary)' : 'var(--orange)'
    const icon    = isCrit ? 'ti-alert-triangle' : isWarn ? 'ti-alert-circle' : isOff ? 'ti-wifi-off' : 'ti-shield-off'
    const border  = isCrit ? 'rgba(239,68,68,.3)' : isWarn ? 'rgba(245,158,11,.25)' : 'var(--border)'
    const leftBar = isCrit ? 'var(--red)' : isWarn ? 'var(--amber)' : isOff ? 'var(--text-tertiary)' : 'var(--orange)'

    return `
    <div style="background:var(--bg-secondary);border:1px solid ${border};border-left:3px solid ${leftBar};border-radius:var(--radius);padding:12px 14px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <i class="ti ${icon}" style="font-size:18px;color:${color};margin-top:1px;flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.hostname)}</div>
          <div style="font-size:12px;color:${color};font-weight:500;margin-top:2px">${esc(a.message)}</div>
          ${a.sub ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${esc(a.sub)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="window.location.hash='#/poste/${esc(a.id)}'"
          style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;
                 color:var(--text-primary);font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">
          <i class="ti ti-device-laptop" style="font-size:14px"></i> ${t('mobile.alertes.see_device')}
        </button>
        <button onclick="mAlNewTicket('${esc(a.id)}', ${jsArg(a.hostname)}, ${jsArg(a.message)})"
          style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;
                 color:var(--text-primary);font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">
          <i class="ti ti-ticket" style="font-size:14px"></i> ${t('mobile.alertes.new_ticket')}
        </button>
      </div>
    </div>`
  }).join('')

  window.mAlNewTicket = (deviceId, hostname, message) => {
    window.mShowSheet(`
      <div class="m-sheet-title">${t('mobile.alertes.sheet.title')}</div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px">
        <div>
          <div class="m-label">${t('mobile.alertes.sheet.label_title')}</div>
          <input class="m-input" id="m-alt-title" value="${esc(hostname)} — ${esc(message)}" autocomplete="off">
        </div>
        <div>
          <div class="m-label">${t('mobile.alertes.sheet.label_priority')}</div>
          <select class="m-input" id="m-alt-prio">
            <option value="low">${t('mobile.alertes.prio.low')}</option>
            <option value="normal">${t('mobile.alertes.prio.normal')}</option>
            <option value="high" selected>${t('mobile.alertes.prio.high')}</option>
            <option value="critical">${t('mobile.alertes.prio.critical')}</option>
          </select>
        </div>
        <div>
          <div class="m-label">${t('mobile.alertes.sheet.label_desc')}</div>
          <textarea class="m-input" id="m-alt-desc" rows="3" style="resize:none" placeholder="${t('mobile.alertes.sheet.placeholder_desc')}"></textarea>
        </div>
        <button class="m-btn-primary" onclick="mAlSubmitTicket('${esc(deviceId)}')">${t('mobile.alertes.sheet.submit')}</button>
      </div>`)

    window.mAlSubmitTicket = async (did) => {
      const title = document.getElementById('m-alt-title')?.value?.trim()
      if (!title) return
      try {
        await window.api.createTicket({
          title,
          priority:    document.getElementById('m-alt-prio')?.value,
          description: document.getElementById('m-alt-desc')?.value?.trim(),
          device_id:   did,
        })
        window.mCloseSheet()
        window.showToast(t('mobile.alertes.toast.created'), 'success')
      } catch { window.showToast(t('mobile.alertes.toast.error'), 'error') }
    }
  }
}
