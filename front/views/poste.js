// Vue Détail poste — hardware + alertes + tickets + terminal (SSH ou agent)
let _term     = null
let _ws       = null
let _device   = null
const _graphData = {}   // { [graphId]: { type, series, pl, gw } }

export async function renderPosteDetail(container, id) {
  container.innerHTML = `
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:10px">
        <a href="#/postes" class="btn btn-sm"><i class="ti ti-arrow-left"></i></a>
        <h1 class="topbar-title" id="pd-hostname">…</h1>
        <span id="pd-status-badge"></span>
      </div>
      <div class="topbar-actions">
        ${window.appState?.user?.isAdmin ? `
        <button class="btn btn-sm" style="color:var(--red)" onclick="deleteDevice()">
          <i class="ti ti-trash"></i>
        </button>` : ''}
        <button class="btn btn-sm" id="btn-force-checkin" onclick="forceCheckin()" title="Forcer un checkin immédiat">
          <i class="ti ti-refresh"></i> Forcer sync
        </button>
        <button class="btn btn-sm" id="btn-sync-intune" onclick="syncIntune()" title="Déclencher une sync Intune">
          <i class="ti ti-cloud-download"></i> Sync Intune
        </button>
        ${window.OPALE.moduleEnabled('tickets') ? `
        <button class="btn btn-sm" onclick="openNewTicketFromDevice()">
          <i class="ti ti-ticket"></i> ${t('tickets.new.title')}
        </button>` : ''}
        ${window.OPALE.moduleEnabled('remote') ? `
        <button class="btn btn-primary btn-sm" id="btn-ssh" onclick="openSSHMenu(event)">
          <i class="ti ti-terminal"></i> Terminal <i class="ti ti-chevron-down" style="font-size:10px;opacity:.7"></i>
        </button>` : ''}
      </div>
    </div>
    <div id="pd-body" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>
    <!-- Terminal SSH -->
    <div id="ssh-panel" class="ssh-panel">
      <div id="ssh-resize-handle" class="ssh-resize-handle"></div>
      <div class="ssh-panel-bar">
        <span id="ssh-status" class="ssh-status">Déconnecté</span>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" id="btn-ssh-popout" onclick="sshTogglePopout()" title="Agrandir"><i class="ti ti-arrows-maximize"></i></button>
          <button class="btn btn-sm" onclick="toggleTerminal()"><i class="ti ti-x"></i></button>
        </div>
      </div>
      <div id="terminal-mount"></div>
    </div>`

  window.toggleTerminal          = toggleTerminal
  window.openSSHMenu             = openSSHMenu
  window.sshTogglePopout         = sshTogglePopout
  window.openNewTicketFromDevice = openNewTicketFromDevice
  window.openRunScriptModal      = openRunScriptModal
  window.runScript               = runScript
  window.deleteDevice            = deleteDevice
  window.lapsViewPassword        = lapsViewPassword
  window.lapsRequestRotation     = lapsRequestRotation
  window.forceCheckin            = forceCheckin
  window.syncIntune              = syncIntune

  try {
    _device = await window.api.getDevice(id)
    renderBody()
    loadExecHistory()
    loadDeviceCompliance(id)
    if (window.appState?.user?.isAdmin && window.OPALE.moduleEnabled('remote')) loadRemoteSessionsHistory()
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function renderBody() {
  const d   = _device
  const body = document.getElementById('pd-body')

  document.getElementById('pd-hostname').textContent = d.hostname
  document.getElementById('pd-status-badge').outerHTML =
    `<span id="pd-status-badge" class="badge badge-${statusColor(d.status)}">${t('status.' + d.status)}</span>`

  const diskC = (d.disks || []).find(dk => dk.letter === 'C:') || d.disks?.[0]

  body.innerHTML = `
    <!-- Grille principale -->
    <div class="pd-grid">
      <!-- Colonne gauche -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <!-- Hardware -->
        <div class="panel">
          <div class="panel-header">${t('poste.hardware')}</div>
          <div class="hw-grid">
            ${hwRow('ti-building-factory-2', t('poste.hw.manufacturer'), d.manufacturer)}
            ${hwRow('ti-device-laptop',      t('poste.hw.model'),        d.model)}
            ${hwRow('ti-cpu',                t('poste.hw.cpu'),          d.cpu)}
            ${d.system_info?.cores ? hwRow('ti-cpu', 'Cœurs / threads', `${d.system_info.cores}c / ${d.system_info.threads}t${d.system_info.cpu_mhz ? ' · ' + (d.system_info.cpu_mhz / 1000).toFixed(1) + ' GHz' : ''}`) : ''}
            ${hwRow('ti-layers-intersect',   t('poste.hw.ram'),          d.ram_gb ? d.ram_gb + ' Go' : '—')}
            ${hwRow('ti-brand-windows',      t('poste.hw.os'),           d.os)}
            ${hwRow('ti-hash',               t('poste.hw.os_build'),     d.os_build)}
            ${hwRow('ti-fingerprint',        t('poste.hw.serial'),       d.serial)}
            ${hwRow('ti-settings',           t('poste.hw.bios'),         d.bios_version)}
            ${d.system_info?.mainboard ? hwRow('ti-cpu-2', 'Carte mère', [d.system_info.mainboard.manufacturer, d.system_info.mainboard.product].filter(Boolean).join(' ')) : ''}
            ${d.system_info?.gpus?.length ? d.system_info.gpus.map(g => hwRow('ti-device-desktop', 'GPU', g.name + (g.driver_version ? ' · ' + g.driver_version : ''))).join('') : ''}
            ${d.system_info?.monitors_count != null ? hwRow('ti-device-tv', 'Moniteurs', String(d.system_info.monitors_count)) : ''}
            ${d.agent_version ? hwRow('ti-broadcast', 'Agent RMM', 'v' + esc(d.agent_version)) : ''}
            ${hwRow('ti-clock',              t('poste.hw.last_seen'),    formatRelative(d.last_seen))}
            ${d.ip_netbird ? hwRow('ti-network', 'Netbird IP', d.ip_netbird) : ''}
            ${d.compliance_state ? hwRow('ti-shield-check', t('poste.hw.compliance'), complianceBadge(d.compliance_state)) : ''}
            ${d.join_type        ? hwRow('ti-cloud',         t('poste.hw.join_type'),   formatJoinType(d.join_type)) : ''}
            ${d.enrolled_at      ? hwRow('ti-calendar', t('poste.hw.enrolled'),    formatWithDate(d.enrolled_at)) : ''}
            ${d.intune_last_sync ? hwRow('ti-refresh',  t('poste.hw.intune_sync'), formatWithDate(d.intune_last_sync)) : ''}
          </div>
        </div>
        ${securityPanel(d)}
        ${perfPanel(d)}
        ${batteryHealthPanel(d)}
        <!-- Disques -->
        <div class="panel">
          <div class="panel-header">${t('poste.disks')}</div>
          <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0">
            ${(d.disks || []).map(disk => diskRow(disk)).join('') || '<div class="empty-state" style="padding:1rem"><p>—</p></div>'}
          </div>
        </div>
        <!-- Réseau -->
        <div class="panel">
          <div class="panel-header">${t('poste.network')}</div>
          <div style="display:flex;flex-direction:column;gap:6px;padding:4px 0">
            ${(d.network || []).map(iface => netifRow(iface)).join('') || '<div class="empty-state" style="padding:1rem"><p>—</p></div>'}
          </div>
          ${bwPanel(d.bandwidth)}
          ${pingPanel(d.ping)}
        </div>
      </div>
      <!-- Colonne droite -->
      <div style="display:flex;flex-direction:column;gap:16px">
        ${d.user ? `
        <div class="panel">
          <div class="panel-header">${t('poste.user')}</div>
          <div style="display:flex;align-items:center;gap:12px;padding:12px 16px">
            <div class="msg-av" style="width:36px;height:36px;font-size:13px;flex-shrink:0">${initials(d.user.name)}</div>
            <div style="min-width:0">
              <a href="#/users/${esc(d.user.email)}" class="nav-link" style="font-weight:500;font-size:13px;text-decoration:none;color:inherit">${esc(d.user.name || '—')}</a>
              ${d.user.job_title ? `<div style="font-size:11px;color:var(--text-secondary)">${esc(d.user.job_title)}</div>` : ''}
              <a href="mailto:${esc(d.user.email)}" style="font-size:11px;color:var(--blue);text-decoration:none">${esc(d.user.email || '')}</a>
            </div>
          </div>
        </div>` : ''}
        ${threatsPanel(d)}
        ${lapsPanel(d)}
        ${currentUserPanel(d)}
        <!-- Alertes actives -->
        <div class="panel">
          <div class="panel-header">${t('poste.alerts')}</div>
          ${(d.active_alerts || []).length ? d.active_alerts.map(a => `
            <div class="alert-row">
              <i class="ti ti-alert-triangle" style="color:var(--red)"></i>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${esc(a.message || a.type)}</div>
                <div style="font-size:11px;color:var(--text-tertiary)">${formatRelative(a.created_at)}</div>
              </div>
            </div>`).join('')
            : `<div class="empty-state" style="padding:1rem"><i class="ti ti-check" style="color:var(--green)"></i><p>${t('poste.no_alerts')}</p></div>`}
        </div>
        <!-- Conformité (chargé async via /api/devices/:id/compliance) -->
        <div class="panel" id="panel-conformite">
          <div class="panel-header">
            <i class="ti ti-shield-check"></i> Conformité
            <a href="#/conformite" style="font-size:11px;color:var(--blue);margin-left:auto">Toutes les règles</a>
          </div>
          <div id="conformite-content">
            <div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
          </div>
        </div>
        <!-- Tickets récents -->
        <div class="panel">
          <div class="panel-header">
            ${t('poste.tickets')}
            <a href="#/tickets" style="font-size:11px;color:var(--blue)">${t('poste.see_all')}</a>
          </div>
          ${(d.tickets || []).length ? d.tickets.map(tk => `
            <div class="ticket-item" onclick="navigateTo('/tickets')" style="cursor:pointer">
              <div class="ti-header">
                <span class="ti-title">${esc(tk.title)}</span>
                <span class="badge badge-${tk.status === 'resolved' ? 'green' : 'orange'}">${tk.status}</span>
              </div>
              <div class="ti-meta"><span>${formatRelative(tk.created_at)}</span></div>
            </div>`).join('')
            : `<div class="empty-state" style="padding:1rem"><p>${t('poste.no_tickets')}</p></div>`}
        </div>
        <!-- Scripts à distance -->
        <div class="panel" id="panel-scripts">
          <div class="panel-header">
            <i class="ti ti-terminal-2"></i> Scripts à distance
            <button class="btn btn-sm btn-primary" onclick="openRunScriptModal()">
              <i class="ti ti-player-play"></i> Exécuter
            </button>
          </div>
          <div id="exec-history">
            <div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
          </div>
        </div>
        ${(window.appState?.user?.isAdmin && window.OPALE.moduleEnabled('remote')) ? `
        <!-- Historique des accès distants (SSH + console-via-agent) — admin only -->
        <div class="panel" id="panel-remote-sessions">
          <div class="panel-header">
            <i class="ti ti-shield-lock"></i> Accès distants
          </div>
          <div id="remote-sessions-history">
            <div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
          </div>
        </div>` : ''}
      </div>
    </div>`
  initGraphListeners()
}

function hwRow(icon, label, value) {
  if (!value) return ''
  return `<div class="hw-row">
    <i class="ti ${icon}"></i>
    <span class="hw-label">${label}</span>
    <span class="hw-value">${esc(String(value))}</span>
  </div>`
}

function hwRowRaw(icon, label, rawHtml) {
  if (rawHtml == null) return ''
  return `<div class="hw-row">
    <i class="ti ${icon}"></i>
    <span class="hw-label">${label}</span>
    <div class="hw-value">${rawHtml}</div>
  </div>`
}

function securityPanel(d) {
  const hs = d.health_signals
  if (!hs) return ''

  const bl  = hs.bitlocker || {}
  const def = hs.defender  || {}
  const fw  = hs.firewall  || {}

  // BitLocker — critique si désactivé
  const blRow = bl.enabled !== undefined ? hwRowRaw(
    bl.enabled ? 'ti-lock' : 'ti-lock-open', 'BitLocker C:',
    bl.enabled
      ? `<span class="badge badge-green">Activé${bl.encryption_method ? ' · ' + esc(bl.encryption_method) : ''}</span>`
      : `<span class="badge badge-red">Désactivé</span>`
  ) : ''

  // Defender — 3 checks indépendants, critique si l'un est false
  const defItems = [
    { label: 'AV',         val: def.antivirus_enabled },
    { label: 'Temps réel', val: def.realtime_protection },
    { label: 'Spyware',    val: def.antispyware_enabled },
  ].filter(i => i.val !== undefined)
  const defRow = defItems.length ? hwRowRaw('ti-shield', 'Defender',
    defItems.map(i => `<span class="badge badge-${i.val ? 'green' : 'red'}" style="margin-right:3px">${i.val ? '✓' : '✗'} ${i.label}</span>`).join('')
  ) : ''

  // Signature AV — ok < 3j, warning 3-7j, critique > 7j
  const sigAge = def.signature_age_days ?? null
  const sigBadge = sigAge !== null
    ? sigAge > 7  ? `<span class="badge badge-red"    style="margin-left:4px">Ancienne (${sigAge}j)</span>`
    : sigAge > 3  ? `<span class="badge badge-orange" style="margin-left:4px">${sigAge}j</span>`
    :               `<span class="badge badge-green"  style="margin-left:4px">À jour</span>`
    : ''
  const sigRow = def.signature_last_update
    ? hwRowRaw('ti-calendar-event', 'Signature AV', esc(def.signature_last_update) + sigBadge)
    : ''

  // Menaces Defender 30j — ok=0, warning 1-4, critique ≥5
  let threatRow = ''
  if (def.threats_last_30d != null) {
    const tc = def.threats_last_30d
    const tb = tc >= 5  ? `<span class="badge badge-red">${tc} menace${tc > 1 ? 's' : ''} détectée${tc > 1 ? 's' : ''}</span>`
             : tc > 0   ? `<span class="badge badge-orange">${tc} menace${tc > 1 ? 's' : ''}</span>`
             :            `<span class="badge badge-green">Aucune</span>`
    const lastThreat = def.last_threat_at ? ` <span style="font-size:10px;color:var(--text-tertiary)">· dernière ${esc(def.last_threat_at)}</span>` : ''
    threatRow = hwRowRaw('ti-virus', 'Menaces 30j', tb + lastThreat)
  }

  // Pare-feu — ok=tous à true, warning=1 désactivé, critique=2+
  const fwItems = [
    { label: 'Dom',  val: fw.domain_enabled  },
    { label: 'Priv', val: fw.private_enabled },
    { label: 'Pub',  val: fw.public_enabled  },
  ].filter(i => i.val !== undefined)
  const fwDisabled = fwItems.filter(i => !i.val).length
  const fwRow = fwItems.length ? hwRowRaw('ti-wall', 'Pare-feu', (() => {
    const badges = fwDisabled >= 2
      ? `<span class="badge badge-red" style="margin-right:6px">${fwDisabled} désactivés</span>`
      : fwDisabled === 1
      ? `<span class="badge badge-orange" style="margin-right:6px">1 désactivé</span>`
      : ''
    const checks = fwItems.map(i => `<span style="color:var(--${i.val ? 'green' : 'red'})">${i.val ? '✓' : '✗'} ${i.label}</span>`).join(' &nbsp; ')
    return badges + checks
  })()) : ''

  // TPM
  const tpmRow = hs.tpm_present !== undefined ? hwRow('ti-poker-chip', 'TPM', hs.tpm_present ? 'Présent' : 'Absent') : ''

  // Redémarrage en attente — warning (info, pas bloquant)
  const rebootRow = hs.pending_reboot
    ? hwRowRaw('ti-refresh-alert', 'Redémarrage', '<span class="badge badge-orange">En attente</span>')
    : ''

  // Dernière MAJ Windows — ok < 30j, warning 30-90j, critique > 90j
  const lastUpdate = hs.last_windows_update
  const updateAge  = lastUpdate ? Math.floor((Date.now() - new Date(lastUpdate).getTime()) / 86400000) : null
  const updateBadge = updateAge !== null
    ? updateAge > 90 ? `<span class="badge badge-red"    style="margin-left:4px">Ancienne (${updateAge}j)</span>`
    : updateAge > 30 ? `<span class="badge badge-orange" style="margin-left:4px">${updateAge} jours</span>`
    :                  `<span class="badge badge-green"  style="margin-left:4px">Récente</span>`
    : ''
  const updateRow = lastUpdate ? hwRowRaw('ti-calendar-check', 'Dernière MAJ', esc(lastUpdate) + updateBadge) : ''

  const content = blRow + defRow + sigRow + threatRow + fwRow + tpmRow + rebootRow + updateRow
  if (!content.trim()) return ''

  return `
    <div class="panel">
      <div class="panel-header">Sécurité &amp; Santé</div>
      <div class="hw-grid">${content}</div>
    </div>`
}

function perfPanel(d) {
  const sp     = d.system_perf
  const series = d.system_perf_series
  if (!sp && (!series || !series.length)) return ''

  const rows = []

  if (sp) {
    if (sp.ram_used_gb != null) {
      const pct  = sp.ram_used_pct != null ? Math.round(sp.ram_used_pct) : (sp.ram_total_gb ? Math.round(sp.ram_used_gb / sp.ram_total_gb * 100) : 0)
      const cls  = pct >= 90 ? 'danger' : pct >= 80 ? 'warn' : ''
      const col  = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--orange)' : 'var(--green)'
      rows.push(hwRowRaw('ti-layers-intersect', 'RAM',
        `${esc(String(sp.ram_used_gb))} / ${esc(String(sp.ram_total_gb))} Go &nbsp; <span style="font-weight:600;color:${col}">${pct}%</span>
        <div class="qty-bar" style="height:4px;margin-top:3px"><div class="qb ${cls}" style="width:${pct}%"></div></div>`
      ))
    }
    if (sp.cpu_avg_pct != null) {
      const pct = Math.round(sp.cpu_avg_pct)
      const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''
      const col = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--green)'
      rows.push(hwRowRaw('ti-activity', 'CPU',
        `<span style="font-weight:600;color:${col}">${pct}%</span> moy${sp.cpu_max_pct != null ? ` &nbsp;·&nbsp; max <span style="color:var(--text-secondary)">${Math.round(sp.cpu_max_pct)}%</span>` : ''}
        <div class="qty-bar" style="height:4px;margin-top:3px"><div class="qb ${cls}" style="width:${pct}%"></div></div>`
      ))
    }
    if (sp.uptime_seconds != null) {
      const days  = Math.floor(sp.uptime_seconds / 86400)
      const hours = Math.floor((sp.uptime_seconds % 86400) / 3600)
      rows.push(hwRow('ti-clock-hour-3', 'Uptime', days > 0 ? `${days}j ${hours}h` : `${hours}h`))
    }
    if (sp.battery_pct != null) {
      const stat = sp.battery_status || ''
      const icon = stat === 'ac' || stat === 'full' ? 'ti-plug' :
                   stat === 'charging' ? 'ti-battery-charging' :
                   sp.battery_pct < 20 ? 'ti-battery-1' : 'ti-battery'
      const cls  = sp.battery_pct < 20 ? 'badge-red' : sp.battery_pct < 40 ? 'badge-orange' : 'badge-green'
      rows.push(hwRowRaw(icon, 'Batterie',
        `<span class="badge ${cls}">${sp.battery_pct}%</span>${stat ? ' &nbsp; ' + esc(stat) : ''}`
      ))
    }
  }

  // Graphe historique 24h
  const graphHtml = series?.length >= 2 ? `
    <div style="border-top:1px solid var(--border);margin-top:8px;padding:10px 16px 14px">
      <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Historique 24h</div>
      ${renderPerfSvg(series)}
    </div>` : ''

  if (!rows.length && !graphHtml) return ''

  return `
    <div class="panel">
      <div class="panel-header">Performances</div>
      <div class="hw-grid">${rows.join('')}</div>
      ${graphHtml}
    </div>`
}

function renderPerfSvg(series) {
  const PL = 36, PT = 10, PB = 6, H = 110
  const GW = 348, GH = H - PT - PB

  const tMin = new Date(series[0].sampled_at).getTime()
  const tMax = new Date(series[series.length - 1].sampled_at).getTime() || tMin + 1
  const cx = t  => ((new Date(t).getTime() - tMin) / (tMax - tMin)) * GW
  const cy = v  => PT + GH - ((v ?? 0) / 100) * GH

  const gridLines = [100, 50, 0].map(v => {
    const yp = cy(v).toFixed(1)
    return `<line x1="0" y1="${yp}" x2="${GW}" y2="${yp}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>`
  }).join('')
  const yLabels = [100, 50, 0].map(v => {
    const topPct = (cy(v) / H * 100).toFixed(1)
    return `<span style="position:absolute;right:4px;top:${topPct}%;transform:translateY(-50%);font-size:9px;color:var(--text-tertiary)">${v}%</span>`
  }).join('')

  const areaPath = key => {
    const pts = series.map(p => [cx(p.sampled_at), cy(p[key])])
    return `M${pts[0][0].toFixed(1)},${(PT + GH).toFixed(1)} ` +
      pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
      ` L${pts[pts.length - 1][0].toFixed(1)},${(PT + GH).toFixed(1)} Z`
  }
  const linePath = key =>
    series.map((p, i) => `${i === 0 ? 'M' : 'L'}${cx(p.sampled_at).toFixed(1)},${cy(p[key]).toFixed(1)}`).join(' ')

  const hasBattery = series.some(p => p.battery_pct != null)
  const t0 = new Date(series[0].sampled_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const t1 = new Date(series[series.length - 1].sampled_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  // Normaliser vers { t, ... } pour que initGraphListeners (qui utilise p.t) fonctionne
  _graphData['perf'] = { type: 'perf', series: series.map(p => ({ ...p, t: p.sampled_at })), pl: 0, gw: GW }

  return `
    <div style="display:flex;align-items:stretch">
      <div style="width:${PL}px;position:relative;flex-shrink:0">${yLabels}</div>
      <svg viewBox="0 0 ${GW} ${H}" preserveAspectRatio="none" style="flex:1;height:${H}px;display:block;cursor:crosshair" data-graph-id="perf">
        ${gridLines}
        <path d="${areaPath('ram_used_pct')}" fill="var(--green)" opacity=".2"/>
        <path d="${linePath('ram_used_pct')}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <path d="${areaPath('cpu_avg_pct')}" fill="var(--blue)" opacity=".2"/>
        <path d="${linePath('cpu_avg_pct')}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${hasBattery ? `<path d="${linePath('battery_pct')}" fill="none" stroke="var(--orange)" stroke-width="1.2" stroke-dasharray="3,2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
        <line class="g-cursor" x1="0" y1="${PT}" x2="0" y2="${PT + GH}" stroke="var(--text-secondary)" stroke-width="1" style="opacity:0" pointer-events="none" vector-effect="non-scaling-stroke"/>
        <rect x="0" y="${PT}" width="${GW}" height="${GH}" fill="transparent"/>
      </svg>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary);margin-top:3px;padding:0 0 0 ${PL}px">
      <span>${t0}</span>
      <span style="display:flex;gap:10px">
        <span style="color:var(--green)">RAM</span>
        <span style="color:var(--blue)">CPU</span>
        ${hasBattery ? '<span style="color:var(--orange)">Bat.</span>' : ''}
      </span>
      <span>${t1}</span>
    </div>`
}

function batteryHealthPanel(d) {
  const bh = d.system_info?.battery_health
  if (!bh || bh.health_pct == null) return ''

  const health = Math.min(100, bh.health_pct)
  const cls    = health < 70 ? 'danger' : health < 80 ? 'warn' : ''
  const col    = health < 70 ? 'var(--red)' : health < 80 ? 'var(--orange)' : 'var(--green)'
  const cycles = bh.cycle_count && bh.cycle_count > 0 ? bh.cycle_count : null
  const cycleNote = cycles != null
    ? cycles > 1000 ? ' <span class="badge badge-red">Élevé</span>'
    : cycles > 500  ? ' <span class="badge badge-orange">Modéré</span>'
    : ''
    : ''

  return `
    <div class="panel">
      <div class="panel-header"><i class="ti ti-battery-eco" style="margin-right:6px"></i>Santé batterie</div>
      <div class="hw-grid">
        ${hwRowRaw('ti-heart-rate-monitor', 'Santé',
          `<span style="font-weight:700;font-size:14px;color:${col}">${health.toFixed(0)}%</span>
          <div class="qty-bar" style="height:5px;margin-top:4px"><div class="qb ${cls}" style="width:${health}%"></div></div>`
        )}
        ${cycles != null ? hwRowRaw('ti-refresh', 'Cycles', `${cycles}${cycleNote}`) : ''}
        ${bh.chemistry ? hwRow('ti-flask', 'Chimie', bh.chemistry) : ''}
        ${bh.designed_mwh && bh.full_charge_mwh ? hwRow('ti-bolt', 'Capacité', `${+(bh.full_charge_mwh / 1000).toFixed(1)} / ${+(bh.designed_mwh / 1000).toFixed(1)} Wh`) : ''}
      </div>
    </div>`
}

function threatsPanel(d) {
  const def = d.health_signals?.defender
  if (!def || def.threats_last_30d == null || def.threats_last_30d === 0) return ''

  const tc = def.threats_last_30d
  return `
    <div class="panel" style="border-left:3px solid var(--red)">
      <div class="panel-header" style="color:var(--red)">
        <i class="ti ti-virus" style="margin-right:6px"></i>Menaces Defender — 30 derniers jours
      </div>
      <div style="padding:12px 16px">
        <div style="font-size:28px;font-weight:700;color:var(--red);line-height:1">${tc}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">menace${tc > 1 ? 's' : ''} détectée${tc > 1 ? 's' : ''}</div>
        ${def.last_threat_at ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">Dernière détection : ${esc(def.last_threat_at)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:6px">
          <i class="ti ti-info-circle"></i> Détails dans le journal Defender local (Get-MpThreatDetection)
        </div>
      </div>
    </div>`
}

function lapsPanel(d) {
  if (!window.appState?.user?.isAdmin || !d.laps) return ''
  const l = d.laps
  const lapsRow = (icon, label, value) => `
    <div style="display:flex;flex-direction:column;gap:1px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.04em">${label}</span>
      <span style="font-size:12px;font-weight:500;word-break:break-all">${value}</span>
    </div>`
  return `
    <div class="panel">
      <div class="panel-header">
        <i class="ti ti-key" style="margin-right:6px"></i>Compte de récupération
        <span class="badge" style="margin-left:auto;font-size:10px">Admin</span>
      </div>
      <div style="padding:4px 16px 0">
        ${lapsRow('ti-user-shield', 'Utilisateur', esc(l.username))}
        ${l.password_changed_at ? lapsRow('ti-calendar-time', 'Dernière rotation', esc(formatRelative(l.password_changed_at))) : ''}
        ${l.last_viewed_at ? lapsRow('ti-eye', 'Dernier accès', esc(formatRelative(l.last_viewed_at)) + (l.last_viewed_by_name ? ` <span style="color:var(--text-tertiary)">par ${esc(l.last_viewed_by_name)}</span>` : '')) : ''}
        ${l.rotation_requested_at ? lapsRow('ti-refresh', 'Rotation demandée', `<span class="badge badge-orange">${esc(formatRelative(l.rotation_requested_at))}</span>`) : ''}
      </div>
      <div style="display:flex;gap:8px;padding:10px 16px 12px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="lapsViewPassword()">
          <i class="ti ti-eye"></i> Voir le mot de passe
        </button>
        <button class="btn btn-sm" style="color:var(--orange)" onclick="lapsRequestRotation()">
          <i class="ti ti-refresh"></i> Demander rotation
        </button>
      </div>
    </div>`
}

function currentUserPanel(d) {
  if (!window.appState?.user?.isAdmin) return ''
  const cu = d.system_info?.current_user
  if (!cu) return ''
  const userLink = d.user?.entraId
    ? `<a href="#/users/${esc(d.user.entraId)}" style="font-size:11px;color:var(--blue);text-decoration:none;margin-top:5px;display:inline-flex;align-items:center;gap:4px">
        <i class="ti ti-arrow-right" style="font-size:10px"></i> Voir la fiche de ${esc(d.user.name || d.user.email)}
       </a>`
    : ''
  return `
    <div class="panel">
      <div class="panel-header">
        <i class="ti ti-user-screen" style="margin-right:6px"></i>Session locale
        <span class="badge" style="margin-left:auto;font-size:10px">Admin</span>
      </div>
      <div style="padding:10px 16px 12px">
        <div style="font-size:13px;font-weight:500">${esc(cu)}</div>
        ${userLink}
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:5px">
          <i class="ti ti-lock" style="font-size:10px"></i> Donnée nominative RGPD — usage COGES uniquement
        </div>
      </div>
    </div>`
}

async function lapsViewPassword() {
  if (!_device) return
  try {
    const cred = await window.api.getAdminCredential(_device.id)
    let remaining = 30
    showModal(`
      <div class="modal-title"><i class="ti ti-key"></i> Compte de récupération</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-row">
          <label class="form-label">Utilisateur</label>
          <input class="form-input" id="laps-user-field" readonly>
        </div>
        <div class="form-row">
          <label class="form-label">Mot de passe</label>
          <div style="display:flex;gap:8px">
            <input class="form-input" id="laps-pwd-field" readonly type="password" style="font-family:monospace;letter-spacing:.1em;flex:1">
            <button class="btn btn-sm" onclick="window.lapsTogglePwd()" title="Afficher"><i class="ti ti-eye"></i></button>
            <button class="btn btn-sm btn-primary" onclick="window.lapsCopyPwd()"><i class="ti ti-copy"></i> Copier</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);text-align:center;background:var(--bg-secondary);border-radius:6px;padding:6px">
          Effacement automatique dans <span id="laps-countdown">${remaining}</span>s — pensez à rotater après usage
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Fermer</button>
      </div>`)
    // Injecter les valeurs via DOM (jamais dans l'HTML — sécurité)
    document.getElementById('laps-user-field').value = cred.username
    document.getElementById('laps-pwd-field').value  = cred.password
    window.lapsTogglePwd = () => {
      const f = document.getElementById('laps-pwd-field')
      if (f) f.type = f.type === 'password' ? 'text' : 'password'
    }
    window.lapsCopyPwd = () => {
      navigator.clipboard.writeText(cred.password)
        .then(() => showToast('Mot de passe copié', 'success'))
    }
    const iv = setInterval(() => {
      remaining--
      const el = document.getElementById('laps-countdown')
      if (el) el.textContent = remaining
      if (remaining <= 0) { clearInterval(iv); closeModal() }
    }, 1000)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function lapsRequestRotation() {
  if (!_device) return
  if (!confirm('Demander une rotation du mot de passe de récupération ?\nLa rotation sera effective au prochain checkin de l\'agent (max 15 min).')) return
  try {
    await window.api.rotateAdminCredential(_device.id)
    showToast('Rotation demandée — effective au prochain checkin', 'success')
    _device = await window.api.getDevice(_device.id)
    renderBody()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

function complianceBadge(state) {
  const map = { compliant: '✓ Conforme', noncompliant: '✗ Non conforme', unknown: '? Inconnu', configManager: 'Config Manager' }
  return map[state] || state
}

function formatJoinType(jt) {
  const map = {
    azureADJoined:       'Azure AD Joint',
    hybridAzureADJoined: 'Hybrid Azure AD',
    azureADRegistered:   'Azure AD Enregistré',
  }
  return map[jt] || jt
}

function diskRow(disk) {
  const pct = disk.used_pct
  const diskLabel = `<span style="font-size:13px;font-weight:500">${esc(disk.letter)} ${disk.label ? `<span style="color:var(--text-tertiary);font-weight:400">(${esc(disk.label)})</span>` : ''}</span>`
  const sizeNote  = `<div style="font-size:11px;color:var(--text-tertiary);margin-top:3px">${disk.size_gb ? disk.size_gb + ' Go total' : '—'}</div>`
  if (pct == null) {
    return `<div class="disk-detail-row">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">${diskLabel}<span class="badge" style="font-size:11px">—</span></div>
      ${sizeNote}
    </div>`
  }
  const color = pct >= 90 ? 'red' : pct >= 80 ? 'orange' : 'green'
  return `<div class="disk-detail-row">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
      ${diskLabel}
      <span style="font-size:12px;color:var(--${color});font-weight:600">${pct}%</span>
    </div>
    <div class="qty-bar" style="height:6px">
      <div class="qb ${color === 'red' ? 'danger' : color === 'orange' ? 'warn' : ''}" style="width:${pct}%"></div>
    </div>
    ${sizeNote}
  </div>`
}

function fmtBytes(b) {
  if (!b || b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

function fmtMbps(mbps) {
  if (mbps <= 0) return '0 Kbps'
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`
  if (mbps >= 1)    return `${mbps.toFixed(2)} Mbps`
  return `${(mbps * 1000).toFixed(0)} Kbps`
}

// bytes delta + intervalle en SECONDES → Mbps.
// Plafond à 10 Gbps : protège contre les resets de compteur réseau (reboot)
// qui produiraient un delta négatif wrappé en valeur aberrante.
//
// L'intervalle est désormais fourni explicitement par le serveur via
// `secs_since_prev` (cf. api/lib/bandwidth.js) — on ne le DEVINE plus côté
// front par Δt entre 2 samples adjacents (qui était le bug du pic 9.82 Gbps
// quand 2 samples d'adapters différents étaient consécutifs à quelques ms).
const _BW_MAX_MBPS = 10_000
function bytesToMbps(bytes, secs) {
  if (!secs || secs <= 0) return 0
  if (!bytes || bytes < 0) return 0
  const mbps = (Number(bytes) * 8) / (secs * 1_000_000)
  return mbps > _BW_MAX_MBPS ? 0 : mbps
}

// Rendu SVG bande passante pour une série filtrée (mbpsR/mbpsS déjà calculés)
function renderBwSvg(filteredSeries) {
  const PL = 46, PT = 10, PB = 6, H = 140
  const GW = 348, GH = H - PT - PB
  const tMin = new Date(filteredSeries[0].t).getTime()
  const tMax = new Date(filteredSeries[filteredSeries.length - 1].t).getTime() || tMin + 1
  const maxMbps = Math.max(...filteredSeries.map(p => Math.max(p.mbpsR, p.mbpsS)), 0.001)

  const cx = t => ((new Date(t).getTime() - tMin) / (tMax - tMin)) * GW
  const cy = v => PT + GH - (v / maxMbps) * GH

  const yLevels = [maxMbps, maxMbps / 2, 0]
  const yLabels = yLevels.map(v => {
    const topPct = (cy(v) / H * 100).toFixed(1)
    return `<span style="position:absolute;right:4px;top:${topPct}%;transform:translateY(-50%);font-size:9px;color:var(--text-tertiary);white-space:nowrap">${fmtMbps(v)}</span>`
  }).join('')
  const gridLines = yLevels.map(v => {
    const yp = cy(v).toFixed(1)
    return `<line x1="0" y1="${yp}" x2="${GW}" y2="${yp}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>`
  }).join('')

  const areaPath = key => {
    const pts = filteredSeries.map(p => [cx(p.t), cy(p[key])])
    return `M${pts[0][0].toFixed(1)},${(PT + GH).toFixed(1)} ` +
      pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
      ` L${pts[pts.length - 1][0].toFixed(1)},${(PT + GH).toFixed(1)} Z`
  }
  const linePath = key =>
    filteredSeries.map((p, i) => `${i === 0 ? 'M' : 'L'}${cx(p.t).toFixed(1)},${cy(p[key]).toFixed(1)}`).join(' ')

  const t0 = new Date(filteredSeries[0].t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const t1 = new Date(filteredSeries[filteredSeries.length - 1].t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  if (_graphData['bw']) _graphData['bw'].series = filteredSeries

  return `
    <div style="display:flex;align-items:stretch">
      <div style="width:${PL}px;position:relative;flex-shrink:0">${yLabels}</div>
      <svg viewBox="0 0 ${GW} ${H}" preserveAspectRatio="none" style="flex:1;height:${H}px;display:block;cursor:crosshair" data-graph-id="bw">
        ${gridLines}
        <path d="${areaPath('mbpsR')}" fill="var(--green)" opacity=".25"/>
        <path d="${linePath('mbpsR')}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <path d="${areaPath('mbpsS')}" fill="var(--blue)" opacity=".25"/>
        <path d="${linePath('mbpsS')}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <line class="g-cursor" x1="0" y1="${PT}" x2="0" y2="${PT + GH}" stroke="var(--text-secondary)" stroke-width="1" style="opacity:0" pointer-events="none" vector-effect="non-scaling-stroke"/>
        <rect x="0" y="${PT}" width="${GW}" height="${GH}" fill="transparent"/>
      </svg>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary);margin-top:3px;padding:0 0 0 ${PL}px">
      <span>${t0}</span>
      <span style="display:flex;gap:10px">
        <span style="color:var(--green)">↓ recv</span>
        <span style="color:var(--blue)">↑ sent</span>
      </span>
      <span>${t1}</span>
    </div>`
}

window.selectBwRange = range => {
  const gdata = _graphData['bw']
  if (!gdata?.allSeries) return
  const hoursMap = { '4h': 4, '24h': 24, '7j': 168 }
  const cutoff = Date.now() - (hoursMap[range] || 24) * 3_600_000
  const filtered = gdata.allSeries.filter(p => new Date(p.t).getTime() >= cutoff)
  if (filtered.length < 2) return

  document.querySelectorAll('[data-bw-range]').forEach(el => {
    el.style.borderColor = el.dataset.bwRange === range ? 'var(--accent)' : 'transparent'
  })

  const area = document.getElementById('bw-graph-area')
  if (area) {
    area.innerHTML = renderBwSvg(filtered)
    initGraphListeners()
  }
}

// Graph bande passante (style CheckMK : deux zones remplies, vert=recv, bleu=sent)
function bwPanel(bw) {
  if (!bw) return ''
  const { summary: s, series } = bw
  const hasSummary = s && (s.sent_7d || s.recv_7d)
  const hasSeries  = series && series.length > 1
  if (!hasSummary && !hasSeries) return ''

  let graphHtml = ''
  if (hasSeries) {
    // secs_since_prev est fourni par le serveur (api/lib/bandwidth.js).
    // Fallback 900 s (15 min nominal) si manquant — ne devrait pas arriver
    // en pratique, défensif uniquement.
    const ratesSeries = series.map(p => ({
      ...p,
      mbpsR: bytesToMbps(p.dr || 0, p.secs_since_prev || 900),
      mbpsS: bytesToMbps(p.ds || 0, p.secs_since_prev || 900),
    }))

    // Affichage par défaut : 24h (ou tout si moins de 2 points dans les 24h)
    const cutoff24h = Date.now() - 24 * 3_600_000
    const default24h = ratesSeries.filter(p => new Date(p.t).getTime() >= cutoff24h)
    const displaySeries = default24h.length >= 2 ? default24h : ratesSeries

    _graphData['bw'] = { type: 'bw', series: displaySeries, allSeries: ratesSeries, pl: 0, gw: 348 }

    graphHtml = `<div id="bw-graph-area">${renderBwSvg(displaySeries)}</div>`
  }

  let cardsHtml = ''
  if (hasSummary) {
    const periods = [
      { key: '4h',  label: '4h',  sent: s.sent_4h,  recv: s.recv_4h  },
      { key: '24h', label: '24h', sent: s.sent_24h, recv: s.recv_24h },
      { key: '7j',  label: '7j',  sent: s.sent_7d,  recv: s.recv_7d  },
    ]
    cardsHtml = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:${hasSeries ? '10px' : '0'}">
        ${periods.map(p => `
          <div data-bw-range="${p.key}" onclick="window.selectBwRange('${p.key}')"
               style="cursor:pointer;background:var(--bg-secondary);border-radius:8px;padding:8px;text-align:center;border:1px solid ${p.key === '24h' ? 'var(--accent)' : 'transparent'};transition:border-color .15s">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${p.label}</div>
            <div style="font-size:11px;color:var(--green)">↓ ${fmtBytes(p.recv)}</div>
            <div style="font-size:11px;color:var(--blue)">↑ ${fmtBytes(p.sent)}</div>
          </div>`).join('')}
      </div>`
  }

  // Adapter principal : injecté en titre pour la transparence — l'admin
  // sait que le graphe représente cet adapter spécifique, pas une somme
  // de tous les adapters (Loopback, WSL, VPNs sont exclus).
  const adapterLabel = bw.primary_adapter
    ? `<span style="color:var(--text-secondary);text-transform:none;letter-spacing:normal;font-weight:400;margin-left:6px">· ${esc(bw.primary_adapter)}</span>`
    : ''

  return `
    <div style="border-top:1px solid var(--border);margin-top:8px;padding:10px 16px 14px">
      <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Bande passante${adapterLabel}</div>
      ${graphHtml}
      ${cardsHtml}
    </div>`
}

// Ping — une courbe par host (1.1.1.1, 192.168.100.254…)
function pingPanel(pings) {
  if (!Array.isArray(pings) || !pings.length) return ''
  return pings.map(p => pingHostPanel(p)).join('')
}

function pingHostPanel(ping) {
  if (!ping?.series?.length) return ''
  const series = ping.series
  const allMs  = series.map(p => p.ms).filter(v => v !== null)
  if (!allMs.length) return ''

  const PL = 46, PT = 8, PB = 6, H = 120
  const GW = 348, GH = H - PT - PB

  const maxMs = Math.max(...allMs) || 1
  const minMs = Math.min(...allMs)
  const span  = maxMs - minMs || 1
  const tMin  = new Date(series[0].t).getTime()
  const tMax  = new Date(series[series.length - 1].t).getTime() || tMin + 1

  const cx = t  => ((new Date(t).getTime() - tMin) / (tMax - tMin || 1)) * GW
  const cy = ms => ms === null ? null : PT + GH - ((ms - minMs) / span) * GH

  const yLevels = [maxMs, Math.round((maxMs + minMs) / 2), minMs]
  const yLabels = yLevels.map(v => {
    const yp = PT + GH - ((v - minMs) / span) * GH
    const topPct = (yp / H * 100).toFixed(1)
    return `<span style="position:absolute;right:4px;top:${topPct}%;transform:translateY(-50%);font-size:9px;color:var(--text-tertiary);white-space:nowrap">${v} ms</span>`
  }).join('')
  const gridLines = yLevels.map(v => {
    const yp = (PT + GH - ((v - minMs) / span) * GH).toFixed(1)
    return `<line x1="0" y1="${yp}" x2="${GW}" y2="${yp}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>`
  }).join('')

  const validPts = series.map(p => ({ x: cx(p.t), y: cy(p.ms) })).filter(p => p.y !== null)
  const path = validPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  const dots = series.map(p => {
    if ((p.loss || 0) > 0)
      return `<circle cx="${cx(p.t).toFixed(1)}" cy="${(PT + GH / 2).toFixed(1)}" r="3" fill="var(--red)" opacity=".8"/>`
    const y = cy(p.ms)
    if (y === null) return ''
    return `<circle cx="${cx(p.t).toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="var(--blue)" opacity=".6"/>`
  }).join('')

  const sum = ping.summary
  const periods = [
    { label: '4h',  s: sum['4h']  },
    { label: '24h', s: sum['24h'] },
    { label: '7j',  s: sum['7d']  },
  ]

  const t0  = new Date(series[0].t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const t1  = new Date(series[series.length - 1].t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const gid = `ping-${ping.host}`
  _graphData[gid] = { type: 'ping', series, pl: 0, gw: GW }

  return `
    <div style="border-top:1px solid var(--border);margin-top:8px;padding:10px 16px 14px">
      <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Ping ${esc(ping.host)}</div>
      <div style="display:flex;align-items:stretch">
        <div style="width:${PL}px;position:relative;flex-shrink:0">${yLabels}</div>
        <svg viewBox="0 0 ${GW} ${H}" preserveAspectRatio="none" style="flex:1;height:${H}px;display:block;cursor:crosshair" data-graph-id="${esc(gid)}">
          ${gridLines}
          <path d="${path}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          ${dots}
          <line class="g-cursor" x1="0" y1="${PT}" x2="0" y2="${PT + GH}" stroke="var(--text-secondary)" stroke-width="1" style="opacity:0" pointer-events="none" vector-effect="non-scaling-stroke"/>
          <rect x="0" y="${PT}" width="${GW}" height="${GH}" fill="transparent"/>
        </svg>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;font-size:10px;color:var(--text-tertiary);padding:0 0 0 ${PL}px">
        <span>${t0}</span>
        <span style="color:var(--red);font-size:9px">● perte</span>
        <span>${t1}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px">
        ${periods.map(({ label, s }) => s ? `
          <div style="background:var(--bg-secondary);border-radius:8px;padding:8px;text-align:center">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${label}</div>
            <div style="font-size:12px;font-weight:600">${s.avg_ms ?? '—'} ms</div>
            <div style="font-size:10px;color:${s.loss_pct > 0 ? 'var(--red)' : 'var(--green)'}">
              ${s.loss_pct}% loss · max ${s.max_ms ?? '—'} ms
            </div>
          </div>` : '').join('')}
      </div>
    </div>`
}

function initGraphListeners() {
  document.querySelectorAll('[data-graph-id]').forEach(svg => {
    const gid   = svg.dataset.graphId
    const gdata = _graphData[gid]
    if (!gdata) return

    // Tooltip ancré au conteneur du SVG, pas au curseur global
    const wrap = svg.parentElement
    wrap.style.position = 'relative'
    const tooltip = document.createElement('div')
    tooltip.style.cssText = [
      'position:absolute', 'pointer-events:none', 'display:none',
      'background:var(--bg-primary)', 'border:1px solid var(--border)',
      'border-radius:6px', 'padding:5px 9px', 'font-size:11px',
      'box-shadow:0 4px 12px rgba(0,0,0,.3)', 'z-index:10',
      'white-space:nowrap', 'line-height:1.7', 'top:4px'
    ].join(';')
    wrap.appendChild(tooltip)

    const cursor = svg.querySelector('.g-cursor')
    const { series, pl: PL, gw: GW } = gdata
    const tMin = new Date(series[0].t).getTime()
    const tMax = new Date(series[series.length - 1].t).getTime()

    svg.addEventListener('mousemove', e => {
      const rect     = svg.getBoundingClientRect()
      const vbW      = parseFloat(svg.getAttribute('viewBox').split(' ')[2])
      const mouseVbX = (e.clientX - rect.left) / rect.width * vbW
      const targetT  = tMin + ((mouseVbX - PL) / GW) * (tMax - tMin)

      let nearest = series[0], minDist = Infinity
      for (const p of series) {
        const d = Math.abs(new Date(p.t).getTime() - targetT)
        if (d < minDist) { minDist = d; nearest = p }
      }

      if (cursor) {
        const cx = PL + ((new Date(nearest.t).getTime() - tMin) / (tMax - tMin)) * GW
        cursor.setAttribute('x1', cx.toFixed(1))
        cursor.setAttribute('x2', cx.toFixed(1))
        cursor.style.opacity = '0.5'
      }

      const ts = new Date(nearest.t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      let html = `<div style="color:var(--text-tertiary);font-size:10px;margin-bottom:2px">${ts}</div>`
      if (gdata.type === 'bw') {
        html += `<div><span style="color:var(--green)">↓</span> ${fmtMbps(nearest.mbpsR || 0)}</div>`
        html += `<div><span style="color:var(--blue)">↑</span> ${fmtMbps(nearest.mbpsS || 0)}</div>`
      } else if (gdata.type === 'perf') {
        if (nearest.ram_used_pct != null) html += `<div><span style="color:var(--green)">RAM</span> ${Math.round(nearest.ram_used_pct)}%</div>`
        if (nearest.cpu_avg_pct  != null) html += `<div><span style="color:var(--blue)">CPU</span> ${Math.round(nearest.cpu_avg_pct)}%${nearest.cpu_max_pct != null ? ` · max ${Math.round(nearest.cpu_max_pct)}%` : ''}</div>`
        if (nearest.battery_pct  != null) html += `<div><span style="color:var(--orange)">Bat.</span> ${nearest.battery_pct}%</div>`
      } else {
        html += nearest.ms !== null
          ? `<div style="color:var(--blue)">${nearest.ms} ms</div>`
          : `<div style="color:var(--red)">Timeout</div>`
        if ((nearest.loss || 0) > 0)
          html += `<div style="color:var(--red)">${nearest.loss}% loss</div>`
      }
      tooltip.innerHTML = html
      tooltip.style.display = 'block'
      // Position du tooltip en px relatifs au wrap (son ancêtre positionné)
      const wrapRect = wrap.getBoundingClientRect()
      const relX     = e.clientX - wrapRect.left
      const tipWidth = tooltip.offsetWidth || 100
      tooltip.style.left = (relX + 10 + tipWidth > wrapRect.width ? relX - tipWidth - 6 : relX + 10) + 'px'
    })

    svg.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none'
      if (cursor) cursor.style.opacity = '0'
    })
  })
}

function netifRow(iface) {
  const icon = iface.type === 'wifi' ? 'ti-wifi' : iface.type === 'netbird' ? 'ti-network' : 'ti-plug-connected'
  return `<div class="netif-row">
    <i class="ti ${icon}" style="color:var(--text-tertiary)"></i>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:500">${esc(iface.adapter || '—')}</div>
      <div style="font-size:11px;color:var(--text-tertiary)">${esc(iface.ip || '—')} · ${esc(iface.mac || '—')}</div>
    </div>
    <span class="badge">${iface.type}</span>
  </div>`
}

// ─── Terminal SSH ───
function openSSHMenu(e) {
  const panel = document.getElementById('ssh-panel')
  if (panel?.classList.contains('open')) {
    disconnectSSH()
    panel.classList.remove('open')
    return
  }

  const existing = document.getElementById('ssh-menu-popup')
  if (existing) { existing.remove(); return }

  const btn  = e.currentTarget
  const rect = btn.getBoundingClientRect()
  const menu = document.createElement('div')
  menu.id = 'ssh-menu-popup'
  menu.style.cssText = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;
    background:var(--panel-bg,#1e2030);border:1px solid var(--border);border-radius:8px;
    box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:999;min-width:190px;overflow:hidden`
  // Le menu offre :
  //  - SSH navigateur (chemin classique via mesh VPN → compte SSH dédié)
  //  - SSH local (commande à coller dans un terminal externe)
  //  - Console via agent : ConPTY en SYSTEM servi par l'agent Go déjà
  //    connecté, plus tolérant aux postes hors mesh VPN au prix d'un
  //    scope d'exécution plus large (cf. PRIVACY).
  const itemStyle = `display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;
    background:none;border:none;color:var(--text-primary);
    font-size:13px;cursor:pointer;text-align:left`
  menu.innerHTML = `
    <button id="ssh-opt-browser" style="${itemStyle};border-bottom:1px solid var(--border)">
      <i class="ti ti-browser"></i> SSH navigateur (ici)
    </button>
    <button id="ssh-opt-local" style="${itemStyle};border-bottom:1px solid var(--border)">
      <i class="ti ti-terminal-2"></i> SSH local
    </button>
    <button id="ssh-opt-console" style="${itemStyle}">
      <i class="ti ti-bolt"></i>
      <span>Console via agent</span>
      <span style="margin-left:auto;font-size:11px">${agentStatusBadge(_device.last_seen_ws)}</span>
    </button>`
  document.body.appendChild(menu)

  menu.querySelector('#ssh-opt-browser').onclick = async () => {
    menu.remove()
    panel.classList.add('open')
    await new Promise(r => setTimeout(r, 280))
    await connectSSH()
    initSSHResize()
  }
  menu.querySelector('#ssh-opt-local').onclick = () => {
    menu.remove()
    const user = window.ENV?.SSH_USER || 'opale'
    const port = window.ENV?.SSH_PORT
    const cmd  = `ssh ${user}@${_device.ip_netbird}${port && port !== 22 ? ` -p ${port}` : ''}`
    navigator.clipboard.writeText(cmd).then(() => showToast(`Copié : ${cmd}`, 'success'))
  }
  menu.querySelector('#ssh-opt-console').onclick = async () => {
    menu.remove()
    panel.classList.add('open')
    await new Promise(r => setTimeout(r, 280))
    await connectConsole()
    initSSHResize()
  }

  const close = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) {
      menu.remove()
      document.removeEventListener('click', close)
    }
  }
  setTimeout(() => document.addEventListener('click', close), 0)
}

async function toggleTerminal() {
  const panel = document.getElementById('ssh-panel')
  if (panel.classList.contains('open')) {
    disconnectSSH()
    panel.classList.remove('open', 'popout')
    return
  }
  panel.classList.add('open')
  await new Promise(r => setTimeout(r, 280))
  await connectSSH()
  initSSHResize()
}

async function connectSSH() {
  if (!_device?.ip_netbird) {
    setSSHStatus('Aucune IP Netbird', 'error')
    return
  }
  if (_device.status !== 'online') {
    setSSHStatus('Poste hors ligne', 'error')
    return
  }
  // Motif obligatoire (RGPD / traçabilité). Si l'admin annule, on ferme
  // le panel qui vient d'être ouvert par toggleTerminal/openSSHMenu.
  const reason = await promptRemoteReason('ssh', _device.hostname)
  if (!reason) {
    document.getElementById('ssh-panel')?.classList.remove('open', 'popout')
    setSSHStatus('', '')
    return
  }
  // Charger xterm.js si pas encore fait
  if (!window.Terminal) {
    await loadScript('/xterm.js')
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = '/styles/xterm.css'
    document.head.appendChild(link)
  }

  const mount = document.getElementById('terminal-mount')
  mount.innerHTML = ''

  _term = new window.Terminal({
    theme: {
      background: '#0d1117', foreground: '#e6edf3',
      cursor: '#e6edf3', selectionBackground: '#264f78'
    },
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 13, lineHeight: 1.4,
    cursorBlink: true, allowTransparency: true,
    scrollOnUserInput: false, scrollback: 2000
  })
  _term.open(mount)

  setSSHStatus('Connexion…', 'connecting')
  let nonce
  try {
    ({ nonce } = await window.api.requestSshGrant(_device.id, reason))
  } catch (err) {
    setSSHStatus(err.message || 'Erreur autorisation SSH', 'error')
    return
  }
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl   = `${wsProto}://${location.host}/api/ssh/${_device.id}?nonce=${encodeURIComponent(nonce)}`

  _ws = new WebSocket(wsUrl)

  _ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'data') {
      _term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)))
      _term.scrollToBottom()
    }
    if (msg.type === 'status') setSSHStatus(msg.data, 'ok')
    if (msg.type === 'error')  { setSSHStatus(msg.data, 'error'); _term.write('\r\n\x1b[31m' + msg.data + '\x1b[0m\r\n') }
  }
  _ws.onopen  = () => setSSHStatus('Connecté', 'ok')
  _ws.onclose = () => setSSHStatus('Déconnecté', '')
  _ws.onerror = () => setSSHStatus('Erreur WebSocket', 'error')

  _term.onData((data) => {
    if (_ws.readyState === WebSocket.OPEN)
      _ws.send(JSON.stringify({ type: 'input', data: btoa(data) }))
  })

  fitTerminal()
  const ro = new ResizeObserver(() => fitTerminal())
  ro.observe(mount)
}

function disconnectSSH() {
  _ws?.close()
  _term?.dispose()
  _ws = null; _term = null
}

function fitTerminal() {
  if (!_term) return
  const mount = document.getElementById('terminal-mount')
  if (!mount || !mount.clientWidth) return
  // JetBrains Mono 13px — dimensions approximatives par caractère
  const charW = 7.8, charH = 13 * 1.4
  const cols = Math.max(40, Math.floor(mount.clientWidth  / charW))
  const rows = Math.max(10, Math.floor(mount.clientHeight / charH))
  try { _term.resize(cols, rows) } catch {}
  if (_ws?.readyState === WebSocket.OPEN)
    _ws.send(JSON.stringify({ type: 'resize', data: { cols, rows } }))
}

function sshTogglePopout() {
  const panel = document.getElementById('ssh-panel')
  const btn   = document.getElementById('btn-ssh-popout')
  const isOut = panel.classList.toggle('popout')
  if (btn) btn.querySelector('i').className = isOut ? 'ti ti-arrows-minimize' : 'ti ti-arrows-maximize'
  setTimeout(fitTerminal, 50)
}

function initSSHResize() {
  const handle = document.getElementById('ssh-resize-handle')
  const panel  = document.getElementById('ssh-panel')
  if (!handle || !panel) return
  let startY, startH
  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY
    startH = panel.offsetHeight
    panel.style.transition = 'none'
    const onMove = (e) => {
      panel.style.height = Math.max(150, startH - (e.clientY - startY)) + 'px'
    }
    const onUp = () => {
      panel.style.transition = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      fitTerminal()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  })
}

function setSSHStatus(text, state) {
  const el = document.getElementById('ssh-status')
  if (!el) return
  el.textContent = text
  el.className = `ssh-status ${state ? 'ssh-status-' + state : ''}`
}

// ─── Console via agent ───
// Réutilise le panel ssh-panel + xterm + fitTerminal du flow SSH. La diff vs
// connectSSH est dans le grant endpoint (/console/grant) et le format des
// frames WS (data dans un sous-objet { b64 } plutôt qu'une string brute).
// L'état _ws / _term reste partagé : un seul terminal ouvert à la fois,
// disconnectSSH() ferme l'un comme l'autre.
async function connectConsole(takeover = false, reason = null) {
  // Premier appel : on demande le motif. Lors d'un retry post-takeover,
  // l'appelant passe le reason déjà obtenu pour éviter de re-demander.
  if (!reason) {
    reason = await promptRemoteReason('console', _device.hostname)
    if (!reason) {
      document.getElementById('ssh-panel')?.classList.remove('open', 'popout')
      setSSHStatus('', '')
      return
    }
  }
  if (!window.Terminal) {
    await loadScript('/xterm.js')
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = '/styles/xterm.css'
    document.head.appendChild(link)
  }
  const mount = document.getElementById('terminal-mount')
  mount.innerHTML = ''

  _term = new window.Terminal({
    theme: { background: '#0d1117', foreground: '#e6edf3',
             cursor: '#e6edf3', selectionBackground: '#264f78' },
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 13, lineHeight: 1.4,
    cursorBlink: true, allowTransparency: true,
    scrollOnUserInput: false, scrollback: 2000
  })
  _term.open(mount)

  setSSHStatus('Autorisation…', 'connecting')
  let nonce
  try {
    ({ nonce } = await window.api.requestConsoleGrant(_device.id, takeover, reason))
  } catch (err) {
    if (err.status === 409 && err.body?.code === 'CONSOLE_CONFLICT') {
      // Une autre session console est active sur ce poste. L'admin peut
      // forcer en relançant avec takeover:true (ce qui kill l'ancienne).
      // On RÉUTILISE le reason déjà saisi — pas de re-prompt.
      const h = err.body.holder || {}
      const ok = await showTakeoverConfirm(h.by_name || 'un autre administrateur', h.started_at)
      if (!ok) {
        setSSHStatus('Annulé', '')
        disconnectSSH()
        return
      }
      return connectConsole(true, reason)
    }
    const code = err.body?.code || ''
    const friendly =
      code === 'AGENT_OFFLINE'      ? "L'agent n'est pas connecté en temps réel"
    : code === 'CAPABILITY_MISSING' ? "L'agent doit être mis à jour (capability console manquante)"
    : (err.message || 'Erreur autorisation')
    setSSHStatus(friendly, 'error')
    return
  }

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl   = `${wsProto}://${location.host}/api/console/${_device.id}?nonce=${encodeURIComponent(nonce)}`
  _ws = new WebSocket(wsUrl)

  _ws.onopen  = () => setSSHStatus('Connexion…', 'connecting')
  _ws.onclose = (ev) => setSSHStatus(`Déconnecté${ev.reason ? ' : ' + ev.reason : ''}`, '')
  _ws.onerror = () => setSSHStatus('Erreur WebSocket', 'error')

  _ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'data' && typeof msg.data?.b64 === 'string') {
      _term.write(Uint8Array.from(atob(msg.data.b64), c => c.charCodeAt(0)))
      _term.scrollToBottom()
      return
    }
    if (msg.type === 'opened') {
      setSSHStatus(`Console ouverte${msg.data?.pid ? ' (pid ' + msg.data.pid + ')' : ''}`, 'ok')
      return
    }
    if (msg.type === 'status') {
      setSSHStatus(typeof msg.data === 'string' ? msg.data : '', 'ok')
      return
    }
    if (msg.type === 'error') {
      // `error` arrive sous deux formes : string (refus côté serveur avant
      // l'ouverture, via fail()) ou { message } (erreur agent forwardée).
      const errMsg = typeof msg.data === 'string' ? msg.data : (msg.data?.message || 'Erreur')
      setSSHStatus(errMsg, 'error')
      _term.write('\r\n\x1b[31m' + errMsg + '\x1b[0m\r\n')
      return
    }
    if (msg.type === 'exit') {
      const reason = msg.data?.reason || `code ${msg.data?.code ?? '?'}`
      setSSHStatus('Terminé : ' + reason, '')
      _term.write(`\r\n\x1b[33m[Session terminée : ${reason}]\x1b[0m\r\n`)
    }
  }

  _term.onData((data) => {
    if (_ws.readyState === WebSocket.OPEN)
      _ws.send(JSON.stringify({ type: 'input', data: btoa(data) }))
  })

  fitTerminal()
  const ro = new ResizeObserver(() => fitTerminal())
  ro.observe(mount)
}

// Badge inline dans le menu Terminal pour signaler la disponibilité du
// canal temps réel. Pure UX — l'autorité reste le grant côté serveur, qui
// renverra AGENT_OFFLINE si vraiment indisponible.
function agentStatusBadge(lastSeenWs) {
  if (!lastSeenWs) {
    return `<span style="color:var(--text-muted,#999)">jamais</span>`
  }
  const ageMs = Date.now() - new Date(lastSeenWs).getTime()
  if (ageMs < 2 * 60 * 1000) {
    return `<span style="color:var(--green,#3fb950)">● actif</span>`
  }
  return `<span style="color:var(--text-muted,#999)">${relativeTime(lastSeenWs)}</span>`
}

function relativeTime(iso) {
  if (!iso) return 'récemment'
  const ageSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (ageSec < 60)    return `il y a ${ageSec}s`
  if (ageSec < 3600)  return `il y a ${Math.floor(ageSec/60)}min`
  if (ageSec < 86400) return `il y a ${Math.floor(ageSec/3600)}h`
  return `il y a ${Math.floor(ageSec/86400)}j`
}

// Modal de saisie du motif d'ouverture d'une session distante (console
// SYSTEM ou SSH). Note obligatoire à chaque ouverture (≥ 5 caractères) —
// la catégorie est persistée en localStorage pour éviter de re-cliquer à
// chaque session, mais la note est toujours re-saisie pour forcer une
// vraie justification.
//
// Résout { category, note } si validé, null si annulé.
function promptRemoteReason(kind, hostname) {
  return new Promise(resolve => {
    const STORAGE_KEY = 'remote-reason-last-category'
    const lastCat = localStorage.getItem(STORAGE_KEY) || 'troubleshoot'
    const isConsole = kind === 'console'
    const title = isConsole
      ? t('remote.reason.title_console', { host: hostname })
      : t('remote.reason.title_ssh',     { host: hostname })
    const warn = isConsole
      ? t('remote.reason.warn_console')
      : t('remote.reason.warn_ssh')
    const categories = [
      { id: 'maintenance',  label: t('remote.reason.cat.maintenance') },
      { id: 'troubleshoot', label: t('remote.reason.cat.troubleshoot') },
      { id: 'audit',        label: t('remote.reason.cat.audit') },
      { id: 'incident',     label: t('remote.reason.cat.incident') },
      { id: 'other',        label: t('remote.reason.cat.other') },
    ]

    const modal = document.createElement('div')
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;
      display:flex;align-items:center;justify-content:center`
    modal.innerHTML = `
      <div style="background:var(--panel-bg,#1e2030);padding:22px;border-radius:8px;
        max-width:480px;width:100%;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.4)">
        <h3 style="margin:0 0 8px;font-size:15px;font-weight:600">${esc(title)}</h3>
        <p style="margin:0 0 16px;color:var(--text-secondary,#aaa);font-size:12px;line-height:1.5">
          <i class="ti ti-shield-lock" style="vertical-align:-2px;margin-right:4px"></i>
          ${esc(warn)}
        </p>
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${esc(t('remote.reason.category_label'))}</div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:14px">
          ${categories.map(c => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="radio" name="rr-cat" value="${c.id}" ${c.id === lastCat ? 'checked' : ''}>
              ${esc(c.label)}
            </label>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">
          ${esc(t('remote.reason.note_label'))}
        </div>
        <textarea id="rr-note" rows="3" maxlength="500"
          placeholder="${esc(t('remote.reason.note_placeholder'))}"
          style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);
            background:var(--bg-primary);color:var(--text-primary);font-size:13px;font-family:inherit;
            box-sizing:border-box;resize:vertical;min-height:62px"></textarea>
        <div id="rr-err" style="color:var(--red);font-size:11px;margin-top:4px;display:none"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="btn btn-sm" id="rr-cancel">${esc(t('btn.cancel'))}</button>
          <button class="btn btn-primary btn-sm" id="rr-ok">${esc(t('remote.reason.open'))}</button>
        </div>
      </div>`
    document.body.appendChild(modal)

    const ta = modal.querySelector('#rr-note')
    setTimeout(() => ta.focus(), 50)

    const cleanup = (val) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(val) }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(null) }
    document.addEventListener('keydown', onKey)

    modal.querySelector('#rr-cancel').onclick = () => cleanup(null)
    modal.querySelector('#rr-ok').onclick = () => {
      const category = modal.querySelector('input[name="rr-cat"]:checked')?.value || lastCat
      const note = ta.value.trim()
      if (note.length < 5) {
        const err = modal.querySelector('#rr-err')
        err.textContent = t('remote.reason.err_too_short')
        err.style.display = 'block'
        ta.focus()
        return
      }
      try { localStorage.setItem(STORAGE_KEY, category) } catch {}
      cleanup({ category, note })
    }
  })
}

function showTakeoverConfirm(byName, startedAt) {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;
      display:flex;align-items:center;justify-content:center`
    const when = startedAt ? relativeTime(startedAt) : 'récemment'
    modal.innerHTML = `
      <div style="background:var(--panel-bg,#1e2030);padding:24px;border-radius:8px;
        max-width:440px;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.4)">
        <h3 style="margin:0 0 12px;font-size:16px">Une console est déjà ouverte</h3>
        <p style="margin:0 0 20px;color:var(--text-secondary,#aaa);font-size:13px;line-height:1.5">
          <b>${esc(byName)}</b> a ouvert une console sur ce poste ${esc(when)}.<br>
          En continuant, sa session sera fermée immédiatement et l'éviction
          sera tracée dans l'audit.
        </p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-sm" id="tk-cancel">Annuler</button>
          <button class="btn btn-primary btn-sm" id="tk-confirm">Prendre la main</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    const close = (val) => () => { modal.remove(); resolve(val) }
    modal.querySelector('#tk-cancel').onclick  = close(false)
    modal.querySelector('#tk-confirm').onclick = close(true)
  })
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = src; s.onload = res; s.onerror = rej
    document.head.appendChild(s)
  })
}

// Redirige vers /tickets avec ?new=true&device=<id>. La vue tickets
// parse ces params au load et ouvre la modale moderne (tags, requester,
// assignee, etc.) avec le device pré-rempli. Permet de ne maintenir
// qu'une seule modale de création de ticket dans le codebase.
function openNewTicketFromDevice() {
  if (!_device) return
  navigateTo(`/tickets?new=true&device=${encodeURIComponent(_device.id)}`)
}

function statusColor(s) {
  return s === 'online' ? 'green' : s === 'critical' ? 'red' : s === 'warn' ? 'orange' : 'gray'
}
function initials(str) {
  return (str || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

// ─── Historique des accès distants (admin only) ─────────────────────────────
// Liste les rows de remote_sessions pour ce poste : qui a ouvert quoi
// (SSH ou console-via-agent), quand, depuis quelle IP, durée. Une éviction
// par takeover apparaît avec un badge → l'admin peut retracer la chaîne.
// Conformité du device — chargée async via /api/devices/:id/compliance.
// Le panel est pré-rendu dans renderBody() avec un loader.
//
// Affichage condensé : on liste les fails (et leurs détails), les non
// applicables (repliés), et on n'énumère pas les pass (juste un compteur).
// Le but : le coup d'œil "tout va bien" ou "X choses à corriger ici".
async function loadDeviceCompliance(deviceId) {
  const el = document.getElementById('conformite-content')
  if (!el) return
  let data
  try {
    data = await window.api.getDeviceCompliance(deviceId)
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>Erreur de chargement</p></div>`
    return
  }
  const { results, counts } = data
  const fails = results.filter(r => r.status === 'fail')
  const nas   = results.filter(r => r.status === 'not_applicable')

  // Header summary : ratio + couleur globale.
  const evalTotal = counts.pass + counts.fail
  const sumColor = counts.fail > 0
    ? (fails.some(f => f.severity === 'critical' || f.severity === 'high') ? 'var(--red)' : 'var(--amber)')
    : 'var(--green)'
  const summaryLine = `
    <div style="padding:10px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)">
      <i class="ti ${counts.fail > 0 ? 'ti-shield-x' : 'ti-shield-check'}" style="font-size:18px;color:${sumColor}"></i>
      <span style="font-size:13px;font-weight:500;color:${sumColor}">${counts.pass}/${evalTotal} règles conformes</span>
      ${counts.fail > 0
        ? `<span style="font-size:11px;color:var(--text-tertiary)">· ${counts.fail} à corriger</span>`
        : ''}
      ${nas.length
        ? `<span style="font-size:11px;color:var(--text-tertiary)">· ${nas.length} N/A</span>`
        : ''}
    </div>`

  const failRows = fails.length ? fails.map(r => {
    const sev = r.severity
    const color = (sev === 'critical' || sev === 'high') ? 'var(--red)' : 'var(--amber)'
    const valueHint = r.value && Object.keys(r.value).length
      ? `<span style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono, monospace)">${esc(JSON.stringify(r.value))}</span>`
      : ''
    return `
      <div class="alert-row" onclick="navigateTo('/conformite/${esc(r.rule_id)}')"
           style="border-left:3px solid ${color};cursor:pointer">
        <i class="ti ti-shield-x" style="color:${color};flex-shrink:0"></i>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
          <span style="font-size:13px;font-weight:500">${esc(r.label)}</span>
          ${valueHint}
        </div>
        <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px"></i>
      </div>`
  }).join('') : ''

  const naBlock = nas.length ? `
    <details style="padding:8px 16px">
      <summary style="font-size:12px;color:var(--text-tertiary);cursor:pointer">${nas.length} règle${nas.length > 1 ? 's' : ''} non applicable${nas.length > 1 ? 's' : ''}</summary>
      <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
        ${nas.map(r => `<div style="font-size:12px;color:var(--text-tertiary)">· ${esc(r.label)}</div>`).join('')}
      </div>
    </details>` : ''

  const okState = !fails.length ? `
    <div class="empty-state" style="padding:1rem">
      <i class="ti ti-shield-check" style="color:var(--green)"></i>
      <p>Toutes les règles applicables passent</p>
    </div>` : ''

  el.innerHTML = summaryLine + failRows + okState + naBlock
}

async function loadRemoteSessionsHistory() {
  const el = document.getElementById('remote-sessions-history')
  if (!el || !_device) return
  try {
    const { sessions } = await window.api.getRemoteSessions(_device.id)
    if (!sessions.length) {
      el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>Aucun accès distant enregistré</p></div>`
      return
    }
    el.innerHTML = sessions.map(s => {
      const isActive   = !s.ended_at
      const isAgent    = s.transport === 'agent_console'
      const icon       = isAgent ? 'ti-bolt' : 'ti-terminal'
      const color      = isActive ? 'var(--green)' : (s.end_reason === 'taken-over' ? 'var(--orange,#d29922)' : 'var(--text-tertiary)')
      const label      = isAgent ? (s.shell || 'console') : 'SSH'
      const duration   = isActive ? '(en cours)' : formatDuration(s.duration_s)
      const ipPart     = s.ip ? ` · ${esc(s.ip)}` : ''
      const takenOver  = s.end_reason === 'taken-over'
      // Bouton "voir le log" : visible uniquement pour les sessions terminées
      // (le log est flush au close). Active = pas encore de log capturable.
      const logBtn = !isActive ? `
        <i class="ti ti-history audit-chevron" style="cursor:pointer;color:var(--text-tertiary);margin-left:8px"
           title="Voir le log de la session"
           onclick="event.stopPropagation();window.showSessionLog('${esc(s.id)}',${jsArg(s.by_name || '')},'${esc(s.transport)}',${jsArg(s.started_at)})"></i>
      ` : ''
      return `
        <div class="audit-row">
          <div class="audit-row-main">
            <i class="ti ${icon}" style="color:${color};flex-shrink:0" title="${esc(s.transport)}"></i>
            <span class="audit-row-text">
              <span style="font-weight:500">${esc(s.by_name || '—')}</span>
              <span style="color:var(--text-tertiary)"> · ${esc(label)}${ipPart} · ${esc(duration)}</span>
              ${takenOver ? `<span class="badge" style="margin-left:6px;background:var(--orange-bg,rgba(210,153,34,.15));color:var(--orange,#d29922);font-size:10px">évincé</span>` : ''}
              ${isActive ? `<span class="badge badge-green" style="margin-left:6px;font-size:10px">actif</span>` : ''}
            </span>
            <span class="audit-row-time">${formatRelative(s.started_at)}</span>
            ${logBtn}
          </div>
        </div>`
    }).join('')
  } catch {
    el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>Erreur</p></div>`
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, seconds | 0)
  if (s < 60)    return `${s}s`
  if (s < 3600)  return `${Math.floor(s/60)}min ${s%60}s`
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}min`
  return `${Math.floor(s/86400)}j ${Math.floor((s%86400)/3600)}h`
}

// Replay du log capturé d'une session remote (SSH ou agent_console).
// Format des frames : [{ ts_ms, direction: 'in'|'out', b64 }]. On écrit
// uniquement les frames `out` dans xterm — PowerShell/bash écho-back déjà
// le stdin dans l'output, donc tout reste visible côté admin et on évite
// d'afficher en double les frappes clavier.
window.showSessionLog = async function(sessionId, byName, transport, startedAt) {
  const label = transport === 'agent_console' ? 'console' : 'SSH'
  showModal(`
    <div class="modal-title">
      <i class="ti ti-history"></i> Log session ${esc(label)} — ${esc(byName || '—')}
      <span style="color:var(--text-tertiary);font-weight:normal;font-size:12px;margin-left:8px">${esc(startedAt || '')}</span>
    </div>
    <div id="session-log-mount" style="height:480px;background:#0d1117;border-radius:6px;margin:8px 0;padding:8px;overflow:hidden">
      <div style="color:var(--text-tertiary);padding:1rem">
        <i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Chargement…
      </div>
    </div>
    <div id="session-log-footer" style="font-size:11px;color:var(--text-tertiary);min-height:18px"></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Fermer</button>
    </div>
  `)

  // Charge xterm à la demande (idempotent — déjà chargé si l'admin a
  // ouvert une console live au cours de la session navigateur).
  if (!window.Terminal) {
    await loadScript('/xterm.js')
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = '/styles/xterm.css'
    document.head.appendChild(link)
  }

  let log
  try {
    log = await window.api.getRemoteSessionLog(sessionId)
  } catch (err) {
    const mount = document.getElementById('session-log-mount')
    if (mount) mount.innerHTML = `<div style="color:var(--red);padding:1rem">${esc(err.message || 'Erreur de chargement')}</div>`
    return
  }

  const mount  = document.getElementById('session-log-mount')
  const footer = document.getElementById('session-log-footer')
  if (!mount) return

  if (!log.available) {
    const msg = log.reason === 'feature-not-deployed'
      ? "La capture des logs n'est pas encore activée sur ce serveur. Les sessions futures seront enregistrées."
      : log.reason === 'no-log-for-session'
      ? "Cette session n'a pas de log capturé (probablement antérieure à l'activation de la capture)."
      : "Log indisponible."
    mount.innerHTML = `<div style="color:var(--text-tertiary);padding:1rem">${esc(msg)}</div>`
    return
  }

  mount.innerHTML = ''
  const term = new window.Terminal({
    theme: { background: '#0d1117', foreground: '#e6edf3',
             cursor: '#0d1117', selectionBackground: '#264f78' },
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 12, lineHeight: 1.3,
    cursorBlink: false, allowTransparency: false,
    disableStdin: true, scrollback: 5000, convertEol: true,
  })
  term.open(mount)

  const frames = Array.isArray(log.frames) ? log.frames : []
  // MVP : écriture séquentielle de tous les `out` (instant playback).
  // L'évolution naturelle = un slider replay temporel basé sur ts_ms.
  let outBytes = 0
  for (const fr of frames) {
    if (fr.direction !== 'out' || typeof fr.b64 !== 'string') continue
    const bytes = Uint8Array.from(atob(fr.b64), c => c.charCodeAt(0))
    term.write(bytes)
    outBytes += bytes.length
  }

  if (footer) {
    const sizeKb = (log.size_bytes != null ? log.size_bytes : outBytes) / 1024
    const parts = [`${frames.length} frames`, `${sizeKb.toFixed(1)} KiB`]
    if (log.truncated) parts.push('⚠ tronqué')
    footer.textContent = parts.join(' · ')
  }
}

// ─── Scripts à distance ─────────────────────────────────────────────────────
async function loadExecHistory(offset = 0) {
  const el = document.getElementById('exec-history')
  if (!el || !_device) return
  try {
    const { rows, total, limit } = await window.api.getDeviceExecutions(_device.id, offset)
    if (!rows.length && offset === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>Aucune exécution</p></div>`
      return
    }
    const rowsHtml = rows.map(e => {
      const statusColor = e.status === 'done' ? 'var(--green)' : e.status === 'error' ? 'var(--red)' : e.status === 'running' ? 'var(--blue)' : 'var(--text-tertiary)'
      const statusIcon  = e.status === 'done' ? 'ti-check' : e.status === 'error' ? 'ti-x' : e.status === 'running' ? 'ti-loader-2' : 'ti-clock'
      const hasOutput   = e.output && e.output.trim()
      const rowId       = `exec-${e.id}`
      return `
        <div class="audit-row">
          <div class="audit-row-main" onclick="${hasOutput ? `auditToggleRow('${rowId}')` : ''}">
            <i class="ti ${statusIcon}" style="color:${statusColor};flex-shrink:0"></i>
            <span class="audit-row-text">
              <span style="font-weight:500">${esc(e.script_name || '—')}</span>
              <span style="color:var(--text-tertiary)"> · ${esc(e.by_name || '—')}</span>
            </span>
            <span class="audit-row-time">${formatRelative(e.queued_at)}</span>
            ${hasOutput ? `<i class="ti ti-chevron-right audit-chevron" id="${rowId}-chevron"></i>` : ''}
          </div>
          ${hasOutput ? `<div class="audit-row-detail hidden" id="${rowId}-detail">
            <pre>${esc(e.output)}</pre>
          </div>` : ''}
        </div>`
    }).join('')
    const hasMore = offset + limit < total
    const moreHtml = hasMore
      ? `<div style="padding:8px 12px;text-align:center">
           <button class="btn btn-sm" onclick="loadExecHistory(${offset + limit})">
             <i class="ti ti-chevron-down"></i> Voir plus (${total - offset - limit} restantes)
           </button>
         </div>`
      : ''
    if (offset === 0) {
      el.innerHTML = rowsHtml + moreHtml
    } else {
      el.querySelector('div[style*="text-align:center"]')?.remove()
      el.insertAdjacentHTML('beforeend', rowsHtml + moreHtml)
    }
  } catch {
    const el2 = document.getElementById('exec-history')
    if (el2) el2.innerHTML = `<div class="empty-state" style="padding:1rem"><p>Erreur</p></div>`
  }
}

async function openRunScriptModal() {
  let scripts = []
  try { scripts = await window.api.getScripts() } catch {}
  if (!scripts.length) { showToast('Aucun script disponible', 'error'); return }

  showModal(`
    <div class="modal-title"><i class="ti ti-terminal-2"></i> Exécuter un script sur ${esc(_device.hostname)}</div>
    <div class="form-row">
      <label class="form-label">Script</label>
      <select class="form-input" id="run-script-select">
        ${scripts.map(s => `<option value="${s.id}">${esc(s.name)}${s.category ? ` (${esc(s.category)})` : ''}</option>`).join('')}
      </select>
    </div>
    <p style="font-size:11px;color:var(--text-tertiary);margin:8px 0 0">
      <i class="ti ti-info-circle"></i> L'exécution se fera au prochain checkin de l'agent (max 15 min).
    </p>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="runScript()"><i class="ti ti-player-play"></i> Mettre en file</button>
    </div>`)
}

async function runScript() {
  const scriptId = document.getElementById('run-script-select')?.value
  if (!scriptId || !_device) return
  try {
    await window.api.runScript(scriptId, _device.id)
    closeModal()
    showToast('Script mis en file — résultat dans max 15 min', 'success')
    loadExecHistory()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function deleteDevice() {
  if (!_device) return
  if (!confirm(`Supprimer définitivement "${_device.hostname}" ?\n\nCette action est irréversible.`)) return
  try {
    await window.api.deleteDevice(_device.id)
    showToast('Poste supprimé', 'success')
    navigateTo('/postes')
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function forceCheckin() {
  if (!_device) return
  const btn = document.getElementById('btn-force-checkin')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>' }
  try {
    const res = await window.api.forceCheckinDevices([_device.id])
    const parts = []
    if (res.ok > 0)      parts.push('Checkin déclenché')
    if (res.skipped > 0) parts.push('Sans IP Netbird — ignoré')
    if (res.errors?.length) parts.push('Erreur')
    showToast(parts.join(', '), res.errors?.length ? 'error' : 'success')
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Forcer sync' }
  }
}

async function syncIntune() {
  if (!_device) return
  const btn = document.getElementById('btn-sync-intune')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>' }
  try {
    const res = await window.api.forceSyncDevices([_device.id])
    const parts = []
    if (res.ok > 0)      parts.push('Sync Intune envoyée')
    if (res.skipped > 0) parts.push('Sans Intune — ignoré')
    if (res.errors?.length) parts.push('Erreur')
    showToast(parts.join(', '), res.errors?.length ? 'error' : 'success')
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-cloud-download"></i> Sync Intune' }
  }
}
