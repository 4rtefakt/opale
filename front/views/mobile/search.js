export function renderSearch(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <div class="m-search" style="margin:0;flex:1">
        <i class="ti ti-search"></i>
        <input type="text" id="m-gsearch-q" placeholder="${t('mobile.search.placeholder')}"
          autocomplete="off" autocorrect="off" oninput="mGsearchRun()"
          style="font-size:14px">
      </div>
    </div>
    <div class="m-scroll-list" id="m-gsearch-results" style="padding-top:8px">
      <div style="text-align:center;color:var(--text-tertiary);padding:40px 20px;font-size:13px">
        <i class="ti ti-search" style="font-size:32px;display:block;margin-bottom:8px;opacity:.3"></i>
        ${t('mobile.search.hint_initial')}
      </div>
    </div>`

  // Focus immédiat sur l'input
  requestAnimationFrame(() => document.getElementById('m-gsearch-q')?.focus())

  let _debounce = null
  window.mGsearchRun = () => {
    clearTimeout(_debounce)
    _debounce = setTimeout(runSearch, 250)
  }
}

async function runSearch() {
  const q = document.getElementById('m-gsearch-q')?.value?.trim()
  const results = document.getElementById('m-gsearch-results')
  if (!results) return

  if (!q || q.length < 2) {
    results.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px;font-size:13px">${t('mobile.search.min_chars')}</div>`
    return
  }

  results.innerHTML = `<div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>`

  try {
    const [devData, tickets] = await Promise.all([
      window.api.getDevices({ search: q, limit: 10 }).catch(() => ({ devices: [] })),
      window.api.getTickets({ search: q, limit: 10 }).catch(() => []),
    ])

    const devices = devData.devices || []
    const tks     = Array.isArray(tickets) ? tickets : []

    if (!devices.length && !tks.length) {
      results.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px;font-size:13px">${t('mobile.search.no_results', { q: esc(q) })}</div>`
      return
    }

    let html = ''

    if (devices.length) {
      html += `<div class="m-section" style="margin-bottom:6px">${t('mobile.search.section.devices', { n: devices.length })}</div>`
      html += devices.map(d => {
        const dotColor = d.status === 'online' ? 'var(--green)' : d.status === 'critical' ? 'var(--red)' : d.status === 'warn' ? 'var(--amber)' : 'var(--text-tertiary)'
        const pillCls  = d.status === 'online' ? 'm-pill-on' : d.status === 'critical' ? 'm-pill-crit' : d.status === 'warn' ? 'm-pill-warn' : 'm-pill-off'
        const pillTxt  = d.status === 'online' ? t('mobile.search.status.online') : d.status === 'critical' ? t('mobile.search.status.critical') : d.status === 'warn' ? t('mobile.search.status.warn') : t('mobile.search.status.offline')
        return `
        <div class="m-device-card" onclick="window.location.hash='#/poste/${esc(d.id)}'">
          <div class="m-status-dot" style="background:${dotColor}"></div>
          <div class="m-device-info">
            <div class="m-device-name">${esc(d.hostname)}</div>
            <div class="m-device-sub">${esc(d.model || d.manufacturer || '—')}${d.user?.name ? ' · ' + esc(d.user.name) : ''}</div>
            ${d.ip_netbird ? `<div class="m-device-ip">${esc(d.ip_netbird)}</div>` : ''}
          </div>
          <span class="m-pill ${pillCls}">${pillTxt}</span>
        </div>`
      }).join('')
    }

    if (tks.length) {
      if (devices.length) html += `<div style="height:8px"></div>`
      html += `<div class="m-section" style="margin-bottom:6px">${t('mobile.search.section.tickets', { n: tks.length })}</div>`
      html += tks.map(tk => {
        const pillCls = tk.status === 'resolved' ? 'm-pill-on' : tk.status === 'in_progress' ? 'm-pill-warn' : 'm-pill-off'
        const pillTxt = tk.status === 'resolved' ? t('mobile.search.ticket_status.resolved') : tk.status === 'in_progress' ? t('mobile.search.ticket_status.in_progress') : t('mobile.search.ticket_status.open')
        return `
        <div class="m-device-card" onclick="window.location.hash='#/ticket/${esc(tk.id)}'">
          <div style="width:8px;height:8px;border-radius:50%;background:${tk.status === 'resolved' ? 'var(--green)' : 'var(--amber)'};flex-shrink:0"></div>
          <div class="m-device-info">
            <div class="m-device-name">${esc(tk.title)}</div>
            <div class="m-device-sub">${tk.hostname ? esc(tk.hostname) + ' · ' : ''}${formatRelative(tk.created_at)}</div>
          </div>
          <span class="m-pill ${pillCls}">${pillTxt}</span>
        </div>`
      }).join('')
    }

    results.innerHTML = html
  } catch (err) {
    results.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}
