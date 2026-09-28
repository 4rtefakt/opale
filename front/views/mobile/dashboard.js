export async function renderDashboard(el) {
  el.innerHTML = `
    <div class="m-header big">
      <div class="m-head-text"><h1>${esc(t('nav.dashboard'))}</h1></div>
      <div class="m-actions">
        <button class="m-icon-btn" onclick="window.location.hash='#/search'" title="${esc(t('mobile.dashboard.search_title'))}"><i class="ti ti-search"></i></button>
        <button class="m-icon-btn" onclick="withBusy(this, () => window.api.syncIntune().then(()=>showToast(t('mobile.dashboard.toast.sync_started'),'success')).catch(()=>showToast(t('mobile.dashboard.toast.error'),'error')))" title="${esc(t('mobile.dashboard.sync_title'))}"><i class="ti ti-refresh"></i></button>
      </div>
    </div>
    <div class="m-scroll" id="m-dash-body">
      <div class="m-loading-row"><div class="m-spinner"></div></div>
    </div>`

  try {
    const [devices, alerts, dash] = await Promise.all([
      window.api.getDevices({ limit: 200 }),
      window.api.getAlerts().catch(() => ({ counts: {}, active: [] })),
      window.api.getDashboard().catch(() => null),
    ])
    const k = dash?.kpis || {}

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

      <div class="m-fleet">
        ${k.compliance_failing_devs > 0 ? `<a href="#/conformite">${esc(t('today.fleet.noncompliant', { n: k.compliance_failing_devs }))}</a>` : `<span>${esc(t('today.fleet.compliant'))}</span>`}
        <span>·</span>
        ${(k.deployments_running || k.deployments_pending) ? `<a href="#/packages">${esc(t('today.fleet.deployments', { n: k.deployments_running || 0, p: k.deployments_pending || 0 }))}</a>` : `<span>${esc(t('today.fleet.deployments_idle'))}</span>`}
      </div>

      ${activeAlerts.length ? `
        <div class="m-section">${t('mobile.dashboard.section.active_alerts')}<a class="m-link" href="#/alertes">${esc(t('mobile.alertes.title'))} →</a></div>
        ${activeAlerts.slice(0, 3).map(a => `
          <div class="m-alert-card crit" onclick="window.location.hash='#/poste/${esc(a.device_id)}'">
            <div class="m-alert-head">
              <i class="ti ti-alert-triangle m-alert-icon"></i>
              <div class="m-alert-body">
                <div class="m-alert-title">${esc(a.hostname || '')}</div>
                <div class="m-alert-msg">${esc(a.message || a.type)}</div>
                <div class="m-alert-sub">${formatRelative(a.created_at)}</div>
              </div>
            </div>
          </div>`).join('')}
      ` : ''}

      <div class="m-section">${t('mobile.dashboard.section.recent')}<a class="m-link" href="#/postes">${esc(t('mobile.postes.title'))} →</a></div>
      ${recent.map(d => deviceCard(d)).join('')}
    `
  } catch (err) {
    document.getElementById('m-dash-body').innerHTML = mErrorBox(err.message, () => renderDashboard(el))
  }
}

function deviceCard(d) {
  const dotColor = d.status === 'online' ? 'var(--green)' : d.status === 'critical' ? 'var(--red)' : d.status === 'warn' ? 'var(--amber)' : 'var(--text-tertiary)'
  const pct = parseFloat(d.disk_used_pct) || 0
  const barColor = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
  const pillKey = d.status === 'online' ? 'mobile.device.status.online'
                : d.status === 'critical' ? 'mobile.device.status.critical'
                : d.status === 'warn' ? 'mobile.device.status.warn'
                : 'mobile.device.status.offline'
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
