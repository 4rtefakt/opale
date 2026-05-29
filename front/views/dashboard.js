export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <span class="page-title">${t('dashboard.title')}</span>
      </div>
      <div class="topbar-right">
        <button class="notif-btn" title="${t('dashboard.notifications.title')}" id="notif-btn">
          <i class="ti ti-bell"></i>
        </button>
        <button class="btn" onclick="reloadDash()">
          <i class="ti ti-refresh"></i> ${t('btn.sync')}
        </button>
        <button class="btn btn-primary" onclick="navigateTo('/tickets')">
          <i class="ti ti-plus"></i> ${t('btn.new_ticket')}
        </button>
      </div>
    </div>
    <div class="content" id="dash-content">
      <div class="kpi-grid">
        ${['','','',''].map(() => `<div class="kpi"><div class="kpi-label" style="background:var(--bg-tertiary);border-radius:4px;height:11px;width:80px;"></div></div>`).join('')}
      </div>
    </div>`

  window.reloadDash = reloadDash
  try { await reloadDash() }
  catch (err) {
    document.getElementById('dash-content').innerHTML =
      `<div style="color:var(--red);padding:1rem">${esc(err.message)}</div>`
  }
}

async function reloadDash() {
  // getScripts dépend du module inventory : skip silencieusement si désactivé.
  const scriptsPromise = window.OPALE.moduleEnabled('inventory')
    ? window.api.getScripts().catch(() => [])
    : Promise.resolve([])
  const [data, scripts] = await Promise.all([
    window.api.getDashboard(),
    scriptsPromise,
  ])
  renderDashboardData(data, scripts)
}

function renderDashboardData(data, scripts = []) {
  const el = document.getElementById('dash-content')
  if (!el) return

  const k   = data.kpis || {}
  const thr = data.thresholds || { disk_critical_pct: 90, disk_warn_pct: 80, agent_offline_days: 7 }

  // Badges sidebar
  if (k.alerts_active > 0) {
    const b = document.getElementById('badge-alertes')
    if (b) { b.textContent = k.alerts_active; b.style.display = '' }
  }
  if (k.tickets_open > 0) {
    const b = document.getElementById('badge-tickets')
    if (b) { b.textContent = k.tickets_open; b.style.display = '' }
  }

  // Zone 1 : visible UNIQUEMENT si au moins une carte est non-nulle. Évite
  // un bandeau de zéros bruyant quand tout est nominal.
  const zone1Has = k.alerts_active > 0 || k.proposals_pending > 0
                 || k.disk_critical > 0
                 || k.deployments_running > 0 || k.deployments_pending > 0

  // Score conformité — couleur + barre selon le pourcentage parc
  const sp = k.compliance_score_pct
  const scoreClass     = sp === null ? '' : sp < 60 ? 'c-danger' : sp < 85 ? 'c-warn' : 'c-ok'
  const scoreFillClass = sp === null ? 'fill-ok' : sp < 60 ? 'fill-danger' : sp < 85 ? 'fill-warn' : 'fill-ok'

  const ratio = k.devices_total ? Math.round(100 * k.devices_online / k.devices_total) : 0

  // Distribution agent — affichée uniquement si > 1 version distincte (signal stuck)
  const av = data.agent_versions || { distribution: [] }
  const showVersions = (av.distribution || []).length > 1

  el.innerHTML = `
    ${zone1Has ? `
      <div class="kpi-grid">
        ${kpiCard({
          label: t('dashboard.kpi.alerts'),
          value: k.alerts_active,
          valueClass: 'c-danger',
          icon: 'ti-alert-triangle',
          sub: t('dashboard.kpi.alerts_sub_action'),
          href: '#/alertes',
          dim: k.alerts_active === 0,
        })}
        ${kpiCard({
          label: t('dashboard.kpi.proposals'),
          value: k.proposals_pending,
          valueClass: 'c-warn',
          icon: 'ti-bulb',
          sub: t('dashboard.kpi.proposals_sub'),
          href: '#/tickets',
          dim: k.proposals_pending === 0,
        })}
        ${kpiCard({
          label: t('dashboard.kpi.disk'),
          value: k.disk_critical,
          valueClass: 'c-danger',
          icon: 'ti-device-floppy',
          sub: t('dashboard.kpi.disk_sub', { pct: thr.disk_critical_pct }),
          href: '#/postes?status=critical',
          dim: k.disk_critical === 0,
        })}
        ${kpiCard({
          label: t('dashboard.kpi.deployments'),
          value: k.deployments_running,
          valueClass: 'c-info',
          icon: 'ti-rocket',
          sub: t('dashboard.kpi.deployments_sub', { n: k.deployments_pending }),
          href: '#/packages',
          dim: k.deployments_running === 0 && k.deployments_pending === 0,
        })}
      </div>
    ` : ''}

    <!-- Zone 2 : état du parc, toujours visible -->
    <div class="kpi-grid kpi-grid-3">
      ${kpiCard({
        label: t('dashboard.kpi.online'),
        value: k.devices_online,
        valueClass: 'c-ok',
        icon: 'ti-device-laptop',
        sub: t('dashboard.kpi.online_sub', { n: k.devices_offline }),
        href: '#/postes?status=online',
        bar: { pct: ratio, fill: 'fill-ok' },
      })}
      ${kpiCard({
        label: t('dashboard.kpi.compliance'),
        value: sp === null ? '—' : (sp + '%'),
        valueClass: scoreClass,
        icon: 'ti-shield-check',
        sub: k.compliance_failing_devs > 0
          ? t('dashboard.kpi.compliance_sub', { n: k.compliance_failing_devs })
          : t('dashboard.kpi.compliance_sub_ok'),
        href: '#/conformite',
        bar: sp === null ? null : { pct: sp, fill: scoreFillClass },
      })}
      ${kpiCard({
        label: t('dashboard.kpi.stock'),
        value: k.stock_low,
        valueClass: k.stock_low > 0 ? 'c-warn' : '',
        icon: 'ti-package',
        sub: t('dashboard.kpi.stock_sub'),
        href: '#/stock',
      })}
    </div>

    <!-- Zone 3 : détail 2 colonnes -->
    <div class="main-grid">
      <div class="left-col">
        ${unhealthyPanel(data.unhealthy_devices || [], thr)}
        ${ticketsPanel(data.recent_tickets || [])}
      </div>
      <div class="right-col">
        ${activityPanel(data.recent_activity || [])}
        ${rulesPanel(data.top_failing_rules || [])}
        ${showVersions ? versionsPanel(av) : ''}
        ${scriptsPanel(scripts)}
      </div>
    </div>`
}

// ─── KPI card ───
function kpiCard({ label, value, valueClass = '', icon, sub, href, dim, bar }) {
  const dimStyle = dim ? ' style="opacity:.55"' : ''
  return `
    <a class="kpi kpi-link" href="${esc(href)}"${dimStyle}>
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-val ${valueClass}">${value}</div>
      ${bar ? `<div class="disk-bar" style="width:100%;margin-top:6px"><div class="disk-fill ${bar.fill}" style="width:${bar.pct}%"></div></div>` : ''}
      <div class="kpi-sub">${icon ? `<i class="ti ${icon}"></i>` : ''} ${esc(sub || '')}</div>
    </a>`
}

// ─── Panel : Postes à surveiller ───
function unhealthyPanel(devices, thr) {
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-alert-octagon"></i> ${t('dashboard.unhealthy.title')}</span>
        <a class="ph-link" href="#/postes">${t('dashboard.see_all')}</a>
      </div>
      ${devices.length === 0
        ? `<div class="empty-state" style="padding:1rem"><i class="ti ti-check" style="font-size:20px;color:var(--green)"></i><p>${t('dashboard.unhealthy.empty')}</p></div>`
        : devices.map(d => unhealthyRow(d, thr)).join('')
      }
    </div>`
}

function unhealthyRow(d, thr) {
  const pct       = parseFloat(d.disk_used_pct) || 0
  const fill      = pct >= thr.disk_critical_pct ? 'fill-danger' : pct >= thr.disk_warn_pct ? 'fill-warn' : 'fill-ok'
  const pctClass  = pct >= thr.disk_critical_pct ? 'c-danger'    : pct >= thr.disk_warn_pct ? 'c-warn'    : ''
  const online    = d.last_seen && (Date.now() - new Date(d.last_seen).getTime()) < 3_600_000
  const dotCls    = online ? (pct >= thr.disk_critical_pct ? 'dot-crit' : 'dot-on') : 'dot-off'
  const offline   = !online
  const badges    = []
  if (d.crit_fails > 0) badges.push(`<span class="badge b-prog" style="background:var(--red-bg);color:var(--red)" title="${t('dashboard.unhealthy.crit_fails')}">${d.crit_fails} <i class="ti ti-shield-x"></i></span>`)
  else if (d.high_fails > 0) badges.push(`<span class="badge b-prog" style="background:var(--amber-bg);color:var(--amber)" title="${t('dashboard.unhealthy.high_fails')}">${d.high_fails} <i class="ti ti-shield-x"></i></span>`)
  if (offline) badges.push(`<span class="badge b-closed" title="${t('dashboard.unhealthy.offline')}"><i class="ti ti-plug-off"></i> ${formatRelative(d.last_seen)}</span>`)

  return `
    <div class="asset-row" onclick="navigateTo('/postes/${esc(d.id)}')">
      <div class="asset-ico"><i class="ti ti-device-laptop"></i></div>
      <div class="asset-info">
        <div class="asset-name"><a href="#/postes/${esc(d.id)}" class="nav-link">${esc(d.hostname)}</a></div>
        <div class="asset-meta">${d.user_name ? esc(d.user_name) + ' · ' : ''}${esc(d.model || '—')}</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">${badges.join('')}</div>
      <div class="disk-wrap">
        <div class="disk-bar"><div class="disk-fill ${fill}" style="width:${pct}%"></div></div>
        <span class="disk-pct ${pctClass}">${pct}%</span>
      </div>
      <div class="sdot ${dotCls}"></div>
    </div>`
}

// ─── Panel : Tickets ouverts ───
function ticketsPanel(tickets) {
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-ticket"></i> ${t('dashboard.tickets')}</span>
        <a class="ph-link" href="#/tickets">${t('dashboard.see_all')}</a>
      </div>
      ${tickets.length === 0
        ? `<div class="empty-state" style="padding:1rem"><i class="ti ti-check" style="font-size:20px;color:var(--green)"></i><p>${t('dashboard.empty.tickets')}</p></div>`
        : tickets.map(ticketRow).join('')
      }
    </div>`
}

function ticketRow(ticket) {
  const badgeCls = ticket.is_auto ? 'b-auto'
    : ticket.status === 'in_progress' ? 'b-prog'
    : ticket.status === 'open' ? 'b-open'
    : 'b-done'
  const badgeLbl = ticket.is_auto ? t('tickets.filter.auto')
    : ticket.status === 'in_progress' ? t('tickets.status.in_progress')
    : ticket.status === 'open' ? t('tickets.status.open')
    : t('tickets.status.resolved')
  const who = ticket.user_id
    ? `<a href="#/users/${esc(ticket.user_id)}" class="nav-link">${esc(ticket.user_name || ticket.user_email || ticket.user_id)}</a>`
    : t('dashboard.ticket.auto_alert')
  return `
    <div class="ticket-row" onclick="navigateTo('/tickets')">
      <span class="badge ${badgeCls}">${badgeLbl}</span>
      <div>
        <div class="ticket-title">${esc(ticket.title)}</div>
        <div class="ticket-meta">${who} · ${formatRelative(ticket.created_at)}</div>
      </div>
    </div>`
}

// ─── Panel : Activité récente (audit_logs) ───
function activityPanel(rows) {
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-history"></i> ${t('dashboard.activity.title')}</span>
        <a class="ph-link" href="#/audit">${t('dashboard.see_all')}</a>
      </div>
      ${rows.length === 0
        ? `<div class="empty-state" style="padding:1rem"><i class="ti ti-history" style="font-size:20px"></i><p>${t('dashboard.activity.empty')}</p></div>`
        : rows.map(activityRow).join('')
      }
    </div>`
}

// Subset des badges/labels audit.js — affichage compact pour le dashboard.
const _ACTIVITY_ICON = {
  agent_console_open:        'ti-terminal-2',
  agent_console_close:       'ti-terminal-2',
  agent_console_takeover:    'ti-hand-grab',
  ssh_open:                  'ti-terminal',
  ssh_close:                 'ti-terminal',
  device_deleted:            'ti-trash',
  intune_sync:               'ti-cloud-download',
  intune_force_sync:         'ti-cloud-download',
  rmm_force_checkin:         'ti-refresh',
  token_created:             'ti-key',
  token_revoked:             'ti-key-off',
  token_rotated:             'ti-key',
  admin_granted:             'ti-shield-check',
  admin_revoked:             'ti-shield-off',
  package_deployed:          'ti-rocket',
  compliance_changed:        'ti-shield',
  tamper_detected:           'ti-bug',
  agent_bootstrap_exchange:  'ti-arrows-exchange',
  laps_rotated:              'ti-lock',
  script_executed_remote:    'ti-terminal-2',
}

function activityRow(r) {
  const icon  = _ACTIVITY_ICON[r.action] || 'ti-dots'
  const key   = 'dashboard.activity.action.' + r.action
  let   label = t(key)
  if (label === key) label = r.action.replace(/_/g, ' ')
  const where = r.device_hostname
    ? `<a href="#/postes/${esc(r.device_id)}" class="nav-link" onclick="event.stopPropagation()">${esc(r.device_hostname)}</a>`
    : (r.target ? esc(r.target) : '')
  const who   = r.by_user ? esc(r.by_user) : ''
  const meta  = [who, where].filter(Boolean).join(' · ')
  return `
    <div class="alert-row" onclick="navigateTo('/audit')">
      <div class="alert-ico ai-info"><i class="ti ${icon}"></i></div>
      <div class="alert-text">
        <div>${esc(label)}</div>
        ${meta ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${meta}</div>` : ''}
      </div>
      <span class="alert-time">${formatRelative(r.created_at)}</span>
    </div>`
}

// ─── Panel : Top règles compliance en échec ───
function rulesPanel(rules) {
  if (rules.length === 0) return ''
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-shield-x"></i> ${t('dashboard.rules.title')}</span>
        <a class="ph-link" href="#/conformite">${t('dashboard.see_all')}</a>
      </div>
      ${rules.map(ruleRow).join('')}
    </div>`
}

function ruleRow(r) {
  const cls = r.severity === 'critical' ? 'ai-danger'
            : r.severity === 'high'     ? 'ai-danger'
            : r.severity === 'medium'   ? 'ai-warn'
            : 'ai-info'
  return `
    <div class="alert-row" onclick="navigateTo('/conformite/${esc(r.id)}')">
      <div class="alert-ico ${cls}"><i class="ti ti-shield-x"></i></div>
      <div class="alert-text">${esc(r.label)}</div>
      <span class="badge b-closed">${r.fail}</span>
    </div>`
}

// ─── Panel : Distribution agent (conditionnel) ───
function versionsPanel(av) {
  const total = (av.distribution || []).reduce((acc, v) => acc + v.count, 0) || 1
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-versions"></i> ${t('dashboard.versions.title')}</span>
        ${av.latest ? `<span class="ph-link" style="cursor:default" title="${t('dashboard.versions.latest_tt')}">v${esc(av.latest)}</span>` : ''}
      </div>
      ${av.distribution.map(v => {
        const isLatest = av.latest && v.agent_version === av.latest
        const pct = Math.round(100 * v.count / total)
        return `
          <div class="alert-row" style="cursor:default">
            <div class="alert-ico ${isLatest ? 'ai-info' : 'ai-warn'}"><i class="ti ti-tag"></i></div>
            <div class="alert-text">
              <div>v${esc(v.agent_version)}${isLatest ? '' : ` <span style="color:var(--text-tertiary);font-size:11px">(${t('dashboard.versions.outdated')})</span>`}</div>
              <div class="disk-bar" style="width:100%;margin-top:4px"><div class="disk-fill ${isLatest ? 'fill-ok' : 'fill-warn'}" style="width:${pct}%"></div></div>
            </div>
            <span class="alert-time">${v.count}</span>
          </div>`
      }).join('')}
    </div>`
}

// ─── Panel : Scripts rapides ───
function scriptsPanel(scripts) {
  return `
    <div class="panel">
      <div class="ph">
        <span class="ph-title"><i class="ti ti-terminal-2"></i> ${t('dashboard.scripts')}</span>
        <a class="ph-link" href="#/scripts">${t('dashboard.scripts_lib')}</a>
      </div>
      ${scripts.length === 0
        ? `<div class="empty-state" style="padding:1rem"><i class="ti ti-terminal-2" style="font-size:20px"></i><p>${t('dashboard.empty.scripts')}</p></div>`
        : scripts.slice(0, 3).map(s => `
            <div class="script-row">
              <div class="script-info">
                <div class="script-name">${esc(s.name)}</div>
                ${s.description ? `<div class="script-desc">${esc(s.description)}</div>` : ''}
              </div>
              <button class="run-btn" onclick="navigateTo('/scripts')"><i class="ti ti-player-play"></i> ${t('btn.run')}</button>
            </div>`).join('')
      }
    </div>`
}
