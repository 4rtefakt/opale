export async function renderDashboard(el) {
  el.innerHTML = `
    <div class="m-header">
      <h1>${t('mobile.dashboard.title')}</h1>
      <button class="m-icon-btn" onclick="window.location.hash='#/search'" title="${t('mobile.dashboard.search_title')}">
        <i class="ti ti-search"></i>
      </button>
      <button class="m-icon-btn" onclick="window.api.syncIntune().then(()=>showToast(t('mobile.dashboard.toast.sync_started'),'success')).catch(()=>showToast(t('mobile.dashboard.toast.error'),'error'))" title="${t('mobile.dashboard.sync_title')}">
        <i class="ti ti-refresh"></i>
      </button>
    </div>
    <div class="m-scroll" id="m-dash-body">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  try {
    const [devices, alerts] = await Promise.all([
      window.api.getDevices({ limit: 200 }),
      window.api.getAlerts().catch(() => ({ counts: {}, active: [] }))
    ])

    const all      = devices.devices || []
    const online   = all.filter(d => d.status === 'online').length
    const offline  = all.filter(d => d.status === 'offline').length
    const critical = all.filter(d => d.status === 'critical' || d.status === 'warn').length
    const activeAlerts = alerts.active || []
    const recent   = [...all].sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0)).slice(0, 6)

    document.getElementById('m-dash-body').innerHTML = `
      <div class="m-stat-row">
        <div class="m-stat-card" onclick="window.location.hash='#/postes'">
          <div class="m-stat-val" style="color:var(--green)">${online}</div>
          <div class="m-stat-lbl">${t('mobile.dashboard.kpi.online')}</div>
        </div>
        <div class="m-stat-card" onclick="window.location.hash='#/postes'">
          <div class="m-stat-val" style="color:var(--text-secondary)">${offline}</div>
          <div class="m-stat-lbl">${t('mobile.dashboard.kpi.offline')}</div>
        </div>
        <div class="m-stat-card" onclick="window.location.hash='#/postes'">
          <div class="m-stat-val" style="color:var(--red)">${critical}</div>
          <div class="m-stat-lbl">${t('mobile.dashboard.kpi.critical')}</div>
        </div>
      </div>

      ${activeAlerts.length ? `
        <div class="m-section">${t('mobile.dashboard.section.active_alerts')}</div>
        ${activeAlerts.slice(0, 3).map(a => `
          <div class="m-alert-card" onclick="window.location.hash='#/poste/${esc(a.device_id)}'">
            <div class="m-alert-title">${esc(a.message || a.type)}</div>
            <div class="m-alert-sub">${esc(a.hostname || '')} · ${formatRelative(a.created_at)}</div>
          </div>`).join('')}
      ` : ''}

      <div class="m-section">${t('mobile.dashboard.section.recent')}</div>
      ${recent.map(d => deviceCard(d)).join('')}
    `
  } catch (err) {
    document.getElementById('m-dash-body').innerHTML =
      `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function deviceCard(d) {
  const dotColor = d.status === 'online' ? 'var(--green)' : d.status === 'critical' ? 'var(--red)' : d.status === 'warn' ? 'var(--amber)' : 'var(--text-tertiary)'
  const pct = parseFloat(d.disk_used_pct) || 0
  const barColor = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
  const pillKey = d.status === 'online' ? 'mobile.dashboard.status.online'
                : d.status === 'critical' ? 'mobile.dashboard.status.critical'
                : d.status === 'warn' ? 'mobile.dashboard.status.warn'
                : 'mobile.dashboard.status.offline'
  return `
    <div class="m-device-card" onclick="window.location.hash='#/poste/${esc(d.id)}'">
      <div class="m-status-dot" style="background:${dotColor}"></div>
      <div class="m-device-info">
        <div class="m-device-name">${esc(d.hostname)}</div>
        <div class="m-device-sub">${esc(d.user?.name || d.model || '—')}</div>
        ${d.ip_netbird ? `<div class="m-device-ip">${esc(d.ip_netbird)}</div>` : ''}
      </div>
      <div class="m-device-right">
        <span class="m-pill m-pill-${d.status === 'online' ? 'on' : d.status === 'critical' ? 'crit' : d.status === 'warn' ? 'warn' : 'off'}">${t(pillKey)}</span>
        ${pct > 0 ? `<div class="m-disk-mini"><div class="m-disk-mini-fill" style="width:${pct}%;background:${barColor}"></div></div>` : ''}
      </div>
    </div>`
}
