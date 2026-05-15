// Vue Rapports — vue agrégée du parc, posture sécurité, activité opérationnelle.
// Pas d'état temps réel ici : c'est le rôle du Dashboard.

let _charts = []
let _data   = null

// Palette tags identique à la vue Tickets.
const TAG_PALETTE = {
  slate:  '#475569', blue:  '#2563eb', green: '#059669', amber: '#d97706',
  red:    '#dc2626', violet:'#7c3aed', pink:  '#db2777', teal:  '#0d9488',
}

function css(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
}

async function loadChartJs() {
  if (window.Chart) return
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/chart.umd.min.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  window.Chart.defaults.font.family = 'inherit'
  window.Chart.defaults.font.size   = 11
  window.Chart.defaults.color       = css('--text-tertiary') || '#888'
}

function destroyCharts() {
  _charts.forEach(c => c.destroy())
  _charts = []
}

export async function renderRapports(container) {
  destroyCharts()
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('rapports.title')}</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="reloadRapports()">
          <i class="ti ti-refresh"></i> ${t('settings.btn.refresh')}
        </button>
      </div>
    </div>
    <div id="rapports-body" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  window.reloadRapports = async () => {
    destroyCharts()
    await loadData()
  }

  await loadChartJs()
  await loadData()
}

async function loadData() {
  const body = document.getElementById('rapports-body')
  if (!body) return
  try {
    _data = await window.api.getRapports()
    render(body)
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p>${t('error.generic')}</p></div>`
  }
}

function render(body) {
  body.innerHTML = `
    ${renderKpis(_data)}

    <div class="section-label">${t('rapports.sec.security')}</div>
    ${renderCompliance(_data)}

    <div class="section-label">${t('rapports.sec.activity')}</div>
    <div class="rapports-grid-2">
      ${renderActivity(_data)}
      ${renderTicketsByTag()}
    </div>

    <div class="section-label">${t('rapports.sec.hardware')}</div>
    <div class="rapports-grid-2">
      ${renderDiskTop(_data)}
      ${renderBattery(_data)}
    </div>
  `

  // Chart.js : le seul graphique reste celui des tickets par tag.
  buildTicketsChart()
}

// ─── KPIs ──────────────────────────────────────────────────────────────
function renderKpis(d) {
  const k = d.kpis
  const parcPct = k.parc.total > 0
    ? Math.round((k.parc.active_7d / k.parc.total) * 100)
    : 0
  const parcStale = k.parc.total - k.parc.active_7d

  const securityScore = k.security_score
  const scoreColor = securityScore == null ? 'var(--text-tertiary)'
                   : securityScore >= 80   ? 'var(--green)'
                   : securityScore >= 60   ? 'var(--amber)'
                   : 'var(--red)'

  return `
    <div class="kpi-grid">
      <div class="panel kpi">
        <div class="kpi-label"><i class="ti ti-broadcast"></i> ${t('rapports.kpi.parc')}</div>
        <div class="kpi-val">${k.parc.active_7d}<span style="font-size:14px;font-weight:400;color:var(--text-tertiary)">/${k.parc.total}</span></div>
        <div class="kpi-sub">${t('rapports.kpi.parc_sub')}</div>
        ${parcStale > 0
          ? `<div class="badge badge-amber" style="margin-top:6px">${t('rapports.kpi.parc_stale', { n: parcStale })}</div>`
          : `<div class="badge badge-green" style="margin-top:6px">${parcPct} %</div>`}
      </div>

      <div class="panel kpi">
        <div class="kpi-label"><i class="ti ti-shield-check"></i> ${t('rapports.kpi.security')}</div>
        <div class="kpi-val" style="color:${scoreColor}">${securityScore == null ? '—' : securityScore + ' %'}</div>
        <div class="kpi-sub">${t('rapports.kpi.security_sub')}</div>
      </div>

      <div class="panel kpi">
        <div class="kpi-label"><i class="ti ti-settings-automation"></i> ${t('rapports.kpi.actions')}</div>
        <div class="kpi-val">${k.actions_count.toLocaleString('fr-FR')}</div>
        <div class="kpi-sub">${t('rapports.kpi.actions_sub')}</div>
      </div>

      <div class="panel kpi kpi-hero">
        <div class="kpi-label"><i class="ti ti-clock-hour-4"></i> ${t('rapports.kpi.time_saved')}</div>
        <div class="kpi-val">${formatHours(k.time_saved.minutes)}</div>
        <div class="kpi-sub">${t('rapports.kpi.time_saved_sub', { eur: k.time_saved.eur.toLocaleString('fr-FR') })}</div>
        <div class="badge badge-green" style="margin-top:6px">${t('rapports.kpi.time_saved_annual', { eur: k.time_saved.annual_eur.toLocaleString('fr-FR') })}</div>
      </div>
    </div>`
}

function formatHours(minutes) {
  if (minutes < 60) return `${minutes} min`
  const h = Math.round(minutes / 60)
  return `${h} h`
}

// ─── Conformité sécurité ───────────────────────────────────────────────
function renderCompliance(d) {
  if (!d.compliance?.length) return ''
  const total = d.kpis.parc.total

  return `
    <div class="panel">
      <div class="panel-header">
        ${t('rapports.compliance.title')}
        <span class="panel-header-legend">
          <span class="legend-tag"><span class="dot dot-green"></span> ${t('rapports.compliance.ok')}</span>
          <span class="legend-tag"><span class="dot dot-red"></span> ${t('rapports.compliance.ko')}</span>
          <span class="legend-tag"><span class="dot dot-gray"></span> ${t('rapports.compliance.na')}</span>
        </span>
      </div>
      <div class="compliance-grid">
        ${d.compliance.map(c => renderComplianceRow(c, total)).join('')}
      </div>
    </div>`
}

function renderComplianceRow(c, total) {
  const okPct = total > 0 ? (c.ok / total) * 100 : 0
  const koPct = total > 0 ? (c.ko / total) * 100 : 0
  return `
    <div class="compliance-row">
      <span class="compliance-label">${t('rapports.compliance.row.' + c.key)}</span>
      <div class="compliance-bar-bg">
        ${c.ok > 0 ? `<div class="compliance-bar-ok" style="width:${okPct.toFixed(2)}%"></div>` : ''}
        ${c.ko > 0 ? `<div class="compliance-bar-ko" style="width:${koPct.toFixed(2)}%"></div>` : ''}
      </div>
      <span class="compliance-counts">
        <strong style="color:var(--green-text)">${c.ok}</strong> /
        <strong style="color:var(--red-text)">${c.ko}</strong> /
        <span>${c.na}</span>
      </span>
    </div>`
}

// ─── Activité opérationnelle ──────────────────────────────────────────
function renderActivity(d) {
  const a = d.activity
  const k = d.kpis.time_saved

  if (!a.length) {
    return `
      <div class="panel">
        <div class="panel-header">${t('rapports.activity.title')}</div>
        <div class="empty-state" style="padding:30px"><p>${t('rapports.activity.empty')}</p></div>
      </div>`
  }

  return `
    <div class="panel">
      <div class="panel-header">
        ${t('rapports.activity.title')}
        <span class="panel-header-note">${t('rapports.activity.note')}</span>
      </div>
      <div class="activity-grid">
        ${a.map(r => `
          <div class="activity-row">
            <span class="activity-label">${esc(r.label)}</span>
            <span class="activity-count">${r.count}</span>
            <span class="activity-time">× ${r.estimated_minutes} min</span>
            <span class="activity-money">${r.total_eur.toLocaleString('fr-FR')} €</span>
          </div>
        `).join('')}
        <div class="activity-row activity-row-total">
          <span class="activity-label"><strong>${t('rapports.activity.total')}</strong></span>
          <span class="activity-count">${d.kpis.actions_count.toLocaleString('fr-FR')}</span>
          <span class="activity-time">${k.minutes.toLocaleString('fr-FR')} min</span>
          <span class="activity-money"><strong>${k.eur.toLocaleString('fr-FR')} €</strong></span>
        </div>
      </div>
    </div>`
}

// ─── Tickets par tag — stacked 12 semaines ────────────────────────────
function renderTicketsByTag() {
  return `
    <div class="panel">
      <div class="panel-header">
        ${t('rapports.tickets.title')}
        <span class="panel-header-note">${t('rapports.tickets.note')}</span>
      </div>
      <div style="padding:14px 16px;height:280px">
        <canvas id="chart-tickets-tags"></canvas>
      </div>
    </div>`
}

function buildTicketsChart() {
  const data = _data.tickets_by_tag
  const canvas = document.getElementById('chart-tickets-tags')
  if (!canvas || !data?.weeks?.length) return

  const border = css('--border') || 'rgba(255,255,255,0.07)'

  const datasets = data.datasets.map(ds => {
    const isUntagged = ds.name === null
    const color      = isUntagged ? css('--text-tertiary') || '#888'
                                  : (TAG_PALETTE[ds.color] || TAG_PALETTE.slate)
    return {
      label:           isUntagged ? t('rapports.tickets.untagged') : ds.name,
      data:            ds.data,
      backgroundColor: color,
      stack:           'tags',
      borderRadius:    0,
      borderSkipped:   false,
    }
  })
  // Arrondir le sommet de la dernière dataset (visuel propre du stacked).
  if (datasets.length) datasets[datasets.length - 1].borderRadius = 4

  // Labels semaines : "2026-W18" → "S18"
  const labels = data.weeks.map(w => {
    const m = w.match(/W(\d+)$/)
    return m ? 'S' + m[1] : w
  })

  _charts.push(new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, boxHeight: 10, padding: 10, usePointStyle: true, pointStyleWidth: 10, font: { size: 10 } },
        },
      },
      scales: {
        y: { beginAtZero: true, stacked: true, ticks: { stepSize: 1 }, grid: { color: border } },
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
      },
    },
  }))
}

// ─── Top postes au disque le plus rempli ──────────────────────────────
function renderDiskTop(d) {
  if (!d.disk_top?.length) {
    return `
      <div class="panel">
        <div class="panel-header">${t('rapports.disk.title')}</div>
        <div class="empty-state" style="padding:30px"><p>${t('rapports.disk.empty')}</p></div>
      </div>`
  }

  return `
    <div class="panel">
      <div class="panel-header">
        ${t('rapports.disk.title')}
        <span class="panel-header-note">${t('rapports.disk.note')}</span>
      </div>
      <div class="disk-grid">
        ${d.disk_top.map(r => {
          const pct   = parseInt(r.disk_used_pct)
          const color = pct >= 90 ? 'var(--red)'   :
                        pct >= 75 ? 'var(--amber)' :
                                    'var(--green)'
          return `
            <div class="disk-row" onclick="navigateTo('/postes/${esc(r.id)}')" style="cursor:pointer">
              <div class="disk-row-label">
                <code class="disk-hostname">${esc(r.hostname || '?')}</code>
                <span class="disk-pct" style="color:${color}">${pct} %</span>
              </div>
              <div class="disk-bar-bg">
                <div class="disk-bar-fill" style="width:${pct}%;background:${color}"></div>
              </div>
            </div>`
        }).join('')}
      </div>
    </div>`
}

// ─── Santé batterie ──────────────────────────────────────────────────
function renderBattery(d) {
  const b = d.battery
  if (!b.total) {
    return `
      <div class="panel">
        <div class="panel-header">${t('rapports.battery.title')}</div>
        <div class="empty-state" style="padding:30px"><p>${t('rapports.battery.empty')}</p></div>
      </div>`
  }

  const max = Math.max(b.good, b.degraded, b.critical, 1)
  const row = (label, count, color) => `
    <div class="battery-row-label">
      <span class="dot" style="background:${color}"></span>
      <span class="legend-label">${label}</span>
      <span style="font-weight:600">${count}</span>
    </div>
    <div class="battery-bar-bg"><div class="battery-bar-fill" style="width:${(count/max*100).toFixed(2)}%;background:${color}"></div></div>
  `

  return `
    <div class="panel">
      <div class="panel-header">
        ${t('rapports.battery.title')}
        <span class="panel-header-note">${t('rapports.battery.note', { n: b.total })}</span>
      </div>
      <div class="battery-grid">
        ${row(t('rapports.battery.good'),     b.good,     'var(--green)')}
        ${row(t('rapports.battery.degraded'), b.degraded, 'var(--amber)')}
        ${row(t('rapports.battery.critical'), b.critical, 'var(--red)')}
      </div>
    </div>`
}
