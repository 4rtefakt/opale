let _device = null

export async function renderPoste(el, id) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="window.location.hash='#/postes'">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 id="m-poste-title" style="flex:1;margin:0;font-size:16px;font-weight:600">…</h1>
      <span id="m-poste-badge"></span>
    </div>
    <div class="m-scroll" id="m-poste-body">
      <div style="display:flex;justify-content:center;padding:40px"><div class="m-spinner"></div></div>
    </div>`

  try {
    _device = await window.api.getDevice(id)
    renderBody(el)
  } catch (err) {
    document.getElementById('m-poste-body').innerHTML =
      `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function renderBody(el) {
  const d = _device
  document.getElementById('m-poste-title').textContent = d.hostname

  const pillCls = d.status === 'online' ? 'on' : d.status === 'critical' ? 'crit' : d.status === 'warn' ? 'warn' : 'off'
  const pillTxt = d.status === 'online' ? 'En ligne' : d.status === 'critical' ? 'Critique' : d.status === 'warn' ? 'Alerte' : 'Hors ligne'
  document.getElementById('m-poste-badge').outerHTML =
    `<span id="m-poste-badge" class="m-pill m-pill-${pillCls}">${pillTxt}</span>`

  const body = document.getElementById('m-poste-body')
  body.innerHTML = `
    <!-- Actions rapides -->
    <div class="m-action-grid">
      ${d.ip_netbird && d.status === 'online' ? `
      <button class="m-action-btn" onclick="mConfirmSSH()">
        <i class="ti ti-terminal"></i>
        <span>SSH</span>
      </button>` : `
      <button class="m-action-btn" disabled style="opacity:.4" title="${d.ip_netbird ? 'Poste hors ligne' : 'IP Netbird manquante'}">
        <i class="ti ti-terminal"></i>
        <span>SSH</span>
      </button>`}
      <button class="m-action-btn" onclick="mOpenNewTicket()">
        <i class="ti ti-ticket"></i>
        <span>Ticket</span>
      </button>
      <button class="m-action-btn" onclick="mForceCheckin()">
        <i class="ti ti-refresh"></i>
        <span>Sync RMM</span>
      </button>
      <button class="m-action-btn" onclick="mSyncDevice()">
        <i class="ti ti-brand-azure"></i>
        <span>Intune</span>
      </button>
      <button class="m-action-btn" onclick="mRunScript()">
        <i class="ti ti-player-play"></i>
        <span>Script</span>
      </button>
    </div>

    <!-- Utilisateur -->
    ${d.user ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-user"></i> Utilisateur</div>
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px">
        <div class="m-av">${initials(d.user.name)}</div>
        <div>
          <div style="font-weight:500;font-size:14px">${esc(d.user.name || '—')}</div>
          ${d.user.job_title ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(d.user.job_title)}</div>` : ''}
          ${d.user.email ? `<div style="font-size:11px;color:var(--blue)">${esc(d.user.email)}</div>` : ''}
        </div>
      </div>
    </div>` : ''}

    <!-- Hardware -->
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-device-laptop"></i> Matériel</div>
      ${hwRow('ti-building-factory-2', 'Fabricant',   d.manufacturer)}
      ${hwRow('ti-device-laptop',      'Modèle',      d.model)}
      ${hwRow('ti-cpu',                'CPU',          d.cpu)}
      ${hwRow('ti-layers-intersect',   'RAM',          d.ram_gb ? d.ram_gb + ' Go' : null)}
      ${hwRow('ti-brand-windows',      'OS',           d.os)}
      ${hwRow('ti-hash',               'Build OS',     d.os_build)}
      ${hwRow('ti-settings',           'BIOS',         d.bios_version)}
      ${hwRow('ti-fingerprint',        'Numéro série', d.serial)}
      ${d.ip_netbird ? hwRowRaw('ti-network', 'Netbird IP', `<span style="cursor:pointer;color:var(--blue-text)" onclick="navigator.clipboard.writeText('${esc(d.ip_netbird)}').then(()=>window.showToast('IP copiée','success'))">${esc(d.ip_netbird)}</span>`) : ''}
      ${hwRow('ti-clock',              'Vu',           formatRelative(d.last_seen))}
      ${d.compliance_state ? hwRowRaw('ti-shield-check', 'Conformité', complianceBadge(d.compliance_state)) : ''}
      ${hwRow('ti-cloud',              'Jonction',     d.join_type ? formatJoinType(d.join_type) : null)}
      ${d.enrolled_at      ? hwRow('ti-calendar-plus', 'Enrôlement',    fmtDate(d.enrolled_at))    : ''}
      ${d.intune_last_sync ? hwRow('ti-refresh',        'Sync Intune',   fmtDate(d.intune_last_sync)) : ''}
    </div>

    <!-- Sécurité & Performances -->
    ${mSecurityPanel(d)}
    ${mPerfPanel(d)}

    <!-- Disques -->
    ${(d.disks || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-database"></i> Disques</div>
      <div style="padding:4px 16px 12px">
        ${d.disks.map(disk => {
          const pct = disk.used_pct ?? 0
          const color = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
          return `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:5px">
              <span style="font-size:13px;font-weight:500">${esc(disk.letter)}${disk.label ? ` <span style="color:var(--text-tertiary);font-weight:400">(${esc(disk.label)})</span>` : ''}</span>
              <span style="font-size:12px;font-weight:600;color:${color}">${pct}%</span>
            </div>
            <div class="m-disk-bar"><div class="m-disk-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:3px">${disk.size_gb} Go total</div>
          </div>`
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Réseau -->
    ${(d.network || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-network"></i> Réseau</div>
      ${d.network.map(iface => {
        const icon = iface.type === 'wifi' ? 'ti-wifi' : iface.type === 'netbird' ? 'ti-network' : 'ti-plug-connected'
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:0.5px solid var(--border)">
          <i class="ti ${icon}" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(iface.adapter || '—')}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${esc(iface.ip || '—')} · ${esc(iface.mac || '—')}</div>
          </div>
          ${iface.type ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg-secondary);color:var(--text-secondary)">${esc(iface.type)}</span>` : ''}
        </div>`
      }).join('')}
    </div>` : ''}

    <!-- Bande passante -->
    ${mBwPanel(d.bandwidth)}

    <!-- Ping -->
    ${mPingPanel(d.ping)}

    <!-- Alertes actives -->
    ${(d.active_alerts || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-alert-triangle" style="color:var(--red)"></i> Alertes actives</div>
      ${d.active_alerts.map(a => `
        <div style="padding:10px 16px;border-bottom:0.5px solid var(--border)">
          <div style="font-size:13px;font-weight:500">${esc(a.message || a.type)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">${formatRelative(a.created_at)}</div>
        </div>`).join('')}
    </div>` : ''}

    <!-- Tickets ouverts -->
    ${(d.tickets || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-ticket"></i> Tickets</div>
      ${d.tickets.map(tk => `
        <div class="m-device-card" onclick="window.location.hash='#/ticket/${esc(tk.id)}'">
          <div class="m-device-info">
            <div class="m-device-name">${esc(tk.title)}</div>
            <div class="m-device-sub">${formatRelative(tk.created_at)}</div>
          </div>
          <span class="m-pill ${tk.status === 'resolved' ? 'm-pill-on' : 'm-pill-warn'}">${tk.status === 'resolved' ? 'Résolu' : 'Ouvert'}</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Scripts à distance -->
    <div class="m-panel" id="m-exec-panel">
      <div class="m-panel-header" style="display:flex;justify-content:space-between;align-items:center">
        <span><i class="ti ti-terminal-2"></i> Scripts</span>
        <button class="m-icon-btn" style="width:28px;height:28px;font-size:14px" onclick="mRunScript()" title="Exécuter">
          <i class="ti ti-player-play"></i>
        </button>
      </div>
      <div id="m-exec-history">
        <div style="display:flex;justify-content:center;padding:16px"><div class="m-spinner" style="width:18px;height:18px;border-width:2px"></div></div>
      </div>
    </div>
  `

  loadExecHistory(d.id)

  // ── Handlers ──────────────────────────────────────────────────────────────

  window.mConfirmSSH = () => {
    const user = window.ENV?.SSH_USER || 'opale'
    const port = window.ENV?.SSH_PORT
    const sshCmd = `ssh ${user}@${d.ip_netbird}${port && port !== 22 ? ` -p ${port}` : ''}`
    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-terminal" style="margin-right:6px"></i>Connexion SSH</div>
      <div style="padding:0 16px 4px;display:flex;flex-direction:column;gap:12px">
        <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:12px;font-size:12px;color:var(--amber);line-height:1.5">
          <strong>Information importante</strong><br>
          Cette connexion SSH est enregistrée (journal d'accès). Elle est réservée à la maintenance technique autorisée.
        </div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">
          Cible : <strong style="color:var(--text-primary)">${esc(d.hostname)}</strong> — ${esc(d.ip_netbird)}
        </div>
        <button class="m-btn-primary" onclick="window.mCloseSheet();window.location.hash='#/ssh/${esc(d.id)}'">
          <i class="ti ti-browser"></i> Navigateur (ici)
        </button>
        <button style="width:100%;padding:13px;border-radius:10px;font-size:14px;font-weight:600;
          background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);cursor:pointer;
          display:flex;align-items:center;justify-content:center;gap:6px"
          onclick="navigator.clipboard.writeText('${esc(sshCmd)}').then(()=>{window.mCloseSheet();window.showToast('Commande copiée','success')})">
          <i class="ti ti-terminal-2"></i> Terminal local
        </button>
        <button style="width:100%;padding:10px;border-radius:10px;font-size:13px;font-weight:500;background:none;border:1px solid var(--border);color:var(--text-secondary);cursor:pointer" onclick="window.mCloseSheet()">
          Annuler
        </button>
      </div>`)
  }

  window.mOpenNewTicket = () => {
    window.mShowSheet(`
      <div class="m-sheet-title">Nouveau ticket</div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px">
        <div>
          <div class="m-label">Titre</div>
          <input class="m-input" id="m-nt-title" value="${esc(d.hostname)} — " autocomplete="off">
        </div>
        <div>
          <div class="m-label">Priorité</div>
          <select class="m-input" id="m-nt-prio">
            <option value="low">Basse</option>
            <option value="normal" selected>Normale</option>
            <option value="high">Haute</option>
            <option value="critical">Critique</option>
          </select>
        </div>
        <div>
          <div class="m-label">Description</div>
          <textarea class="m-input" id="m-nt-desc" rows="3" style="resize:none"></textarea>
        </div>
        <button class="m-btn-primary" onclick="mSubmitNewTicket()">Créer le ticket</button>
      </div>`)
    window.mSubmitNewTicket = async () => {
      const title = document.getElementById('m-nt-title')?.value?.trim()
      if (!title) return
      try {
        await window.api.createTicket({
          title,
          priority: document.getElementById('m-nt-prio')?.value,
          description: document.getElementById('m-nt-desc')?.value?.trim(),
          device_id: d.id
        })
        window.mCloseSheet()
        window.showToast('Ticket créé', 'success')
      } catch { window.showToast('Erreur', 'error') }
    }
  }

  // Verrous anti-double-click : un click pendant qu'une action est en
  // cours (ssh, deploy) est ignoré. Évite les doubles audit_logs et SSH
  // multiples sur le même PC.
  let _mForceCheckinPending = false
  let _mSyncDevicePending   = false

  window.mForceCheckin = async () => {
    if (_mForceCheckinPending) { window.showToast('Action déjà en cours…', 'info'); return }
    _mForceCheckinPending = true
    try {
      const res = await window.api.forceCheckinDevices([d.id])
      if (res.errors?.length) window.showToast(res.errors[0], 'error')
      else window.showToast('Checkin RMM déclenché', 'success')
    } catch { window.showToast('Erreur', 'error') }
    finally { _mForceCheckinPending = false }
  }

  window.mSyncDevice = async () => {
    if (_mSyncDevicePending) { window.showToast('Action déjà en cours…', 'info'); return }
    _mSyncDevicePending = true
    try {
      await window.api.forceSyncDevices([d.id])
      window.showToast('Sync Intune lancée', 'success')
    } catch { window.showToast('Erreur', 'error') }
    finally { _mSyncDevicePending = false }
  }

  window.mRunScript = async () => {
    let scripts = []
    try { scripts = await window.api.getScripts() } catch {}
    if (!scripts.length) { window.showToast('Aucun script', 'error'); return }
    window.mShowSheet(`
      <div class="m-sheet-title">Exécuter un script</div>
      <div style="padding:0 4px">
        <div class="m-label">Script</div>
        <select class="m-input" id="m-run-script-sel">
          ${scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.category ? ` (${esc(s.category)})` : ''}</option>`).join('')}
        </select>
        <p style="font-size:11px;color:var(--text-tertiary);margin:10px 0">L'exécution se fera au prochain checkin de l'agent (max 15 min).</p>
        <button class="m-btn-primary" style="margin-top:4px" onclick="mSubmitRunScript()">Mettre en file</button>
      </div>`)
    window.mSubmitRunScript = async () => {
      const scriptId = document.getElementById('m-run-script-sel')?.value
      if (!scriptId) return
      try {
        await window.api.runScript(scriptId, d.id)
        window.mCloseSheet()
        window.showToast('Script mis en file', 'success')
        loadExecHistory(d.id)
      } catch { window.showToast('Erreur', 'error') }
    }
  }
}

// ── Historique d'exécutions ──────────────────────────────────────────────────

async function loadExecHistory(deviceId, offset = 0) {
  const el = document.getElementById('m-exec-history')
  if (!el) return
  try {
    const { rows, total, limit } = await window.api.getDeviceExecutions(deviceId, offset)
    if (!rows.length && offset === 0) {
      el.innerHTML = `<div style="text-align:center;padding:16px;font-size:12px;color:var(--text-tertiary)">Aucune exécution</div>`
      return
    }
    const rowsHtml = rows.map(e => {
      const statusColor = e.status === 'done' ? 'var(--green)' : e.status === 'error' ? 'var(--red)' : e.status === 'running' ? 'var(--blue)' : 'var(--text-tertiary)'
      const statusIcon  = e.status === 'done' ? 'ti-check' : e.status === 'error' ? 'ti-x' : e.status === 'running' ? 'ti-loader-2' : 'ti-clock'
      const hasOutput   = e.output && e.output.trim()
      const rowId       = `mexec-${e.id}`
      return `
        <div class="m-audit-row">
          <div class="m-audit-row-main" ${hasOutput ? `onclick="mExecToggle('${rowId}')"` : ''} style="${hasOutput ? 'cursor:pointer' : ''}">
            <i class="ti ${statusIcon} m-audit-icon" style="color:${statusColor}"></i>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.script_name || '—')}</div>
              <div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${esc(e.by_name || '—')} · ${formatRelative(e.queued_at)}</div>
            </div>
            ${hasOutput ? `<i class="ti ti-chevron-right m-audit-chevron" id="${rowId}-chev"></i>` : ''}
          </div>
          ${hasOutput ? `
          <div class="m-audit-detail" id="${rowId}-det" style="display:none">
            <pre class="m-audit-log-block">${esc(e.output)}</pre>
          </div>` : ''}
        </div>`
    }).join('')

    const hasMore = offset + limit < total
    const moreHtml = hasMore ? `
      <div id="m-exec-more" style="padding:12px 16px;text-align:center">
        <button class="m-btn-primary" style="font-size:12px;padding:8px" onclick="mLoadMoreExec('${deviceId}',${offset + limit})">
          Voir plus (${total - offset - limit} restantes)
        </button>
      </div>` : ''

    if (offset === 0) {
      el.innerHTML = rowsHtml + moreHtml
    } else {
      document.getElementById('m-exec-more')?.remove()
      el.insertAdjacentHTML('beforeend', rowsHtml + moreHtml)
    }

    window.mExecToggle = (rowId) => {
      const det  = document.getElementById(`${rowId}-det`)
      const chev = document.getElementById(`${rowId}-chev`)
      if (!det) return
      const open = det.style.display !== 'none'
      det.style.display  = open ? 'none' : 'block'
      if (chev) chev.style.transform = open ? '' : 'rotate(90deg)'
    }
    window.mLoadMoreExec = (deviceId, nextOffset) => loadExecHistory(deviceId, nextOffset)
  } catch {
    const el2 = document.getElementById('m-exec-history')
    if (el2) el2.innerHTML = `<div style="text-align:center;padding:16px;font-size:12px;color:var(--text-tertiary)">Erreur</div>`
  }
}

// ── Sécurité & Performances ──────────────────────────────────────────────────

function mSecurityPanel(d) {
  const hs = d.health_signals
  if (!hs) return ''

  const chk = v => v
    ? '<span style="color:var(--green)">✓</span>'
    : '<span style="color:var(--red)">✗</span>'

  const bl  = hs.bitlocker || {}
  const def = hs.defender  || {}
  const fw  = hs.firewall  || {}

  const rows = []

  if (bl.enabled !== undefined) {
    rows.push(hwRowRaw(
      bl.enabled ? 'ti-lock' : 'ti-lock-open', 'BitLocker',
      `<span style="color:var(--${bl.enabled ? 'green' : 'red'})">${bl.enabled ? 'Activé' : 'Désactivé'}</span>${bl.encryption_method ? ' · ' + esc(bl.encryption_method) : ''}`
    ))
  }
  if ([def.antivirus_enabled, def.realtime_protection, def.antispyware_enabled].some(v => v !== undefined)) {
    rows.push(hwRowRaw('ti-shield', 'Defender',
      `${chk(def.antivirus_enabled)} AV · ${chk(def.realtime_protection)} RT · ${chk(def.antispyware_enabled)} AS`
    ))
  }
  if (fw.domain_enabled !== undefined) {
    rows.push(hwRowRaw('ti-wall', 'Pare-feu',
      `${chk(fw.domain_enabled)} Dom · ${chk(fw.private_enabled)} Priv · ${chk(fw.public_enabled)} Pub`
    ))
  }
  if (hs.tpm_present !== undefined) {
    rows.push(hwRow('ti-microchip', 'TPM', hs.tpm_present ? 'Présent' : 'Absent'))
  }
  if (hs.pending_reboot) {
    rows.push(hwRowRaw('ti-refresh-alert', 'Redémarrage', '<span style="color:var(--amber);font-weight:500">En attente</span>'))
  }

  if (!rows.length) return ''

  return `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-shield-lock"></i> Sécurité</div>
      ${rows.join('')}
    </div>`
}

function mPerfPanel(d) {
  const sp = d.system_perf
  const si = d.system_info
  if (!sp && !si) return ''

  const rows = []

  if (sp) {
    if (sp.ram_used_gb != null) {
      const pct   = sp.ram_used_pct ?? (sp.ram_total_gb ? Math.round(sp.ram_used_gb / sp.ram_total_gb * 100) : 0)
      const color = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
      rows.push(`
        <div style="padding:8px 16px;border-bottom:0.5px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <i class="ti ti-layers-intersect" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
            <span style="font-size:12px;color:var(--text-secondary);width:90px;flex-shrink:0">RAM</span>
            <span style="font-size:12px;font-weight:500">${esc(String(sp.ram_used_gb))} / ${esc(String(sp.ram_total_gb))} Go</span>
            <span style="font-size:11px;color:${color};margin-left:auto;font-weight:600">${pct}%</span>
          </div>
          <div class="m-disk-bar" style="margin-left:24px"><div class="m-disk-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>`)
    }
    if (sp.cpu_avg_pct != null) {
      const color = sp.cpu_avg_pct >= 90 ? 'var(--red)' : sp.cpu_avg_pct >= 70 ? 'var(--amber)' : 'var(--green)'
      rows.push(`
        <div style="padding:8px 16px;border-bottom:0.5px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <i class="ti ti-activity" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
            <span style="font-size:12px;color:var(--text-secondary);width:90px;flex-shrink:0">CPU moyen</span>
            <span style="font-size:12px;font-weight:500">${esc(String(sp.cpu_avg_pct))}%</span>
            ${sp.cpu_max_pct != null ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:auto">max ${esc(String(sp.cpu_max_pct))}%</span>` : ''}
          </div>
          <div class="m-disk-bar" style="margin-left:24px"><div class="m-disk-bar-fill" style="width:${sp.cpu_avg_pct}%;background:${color}"></div></div>
        </div>`)
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
      rows.push(hwRow(icon, 'Batterie', `${sp.battery_pct}%${stat ? ' · ' + stat : ''}`))
    }
  }

  if (si?.current_user) rows.push(hwRow('ti-user', 'Connecté', si.current_user))

  if (!rows.length) return ''

  return `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-activity"></i> Performances</div>
      ${rows.join('')}
    </div>`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hwRow(icon, label, value) {
  if (!value) return ''
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:0.5px solid var(--border)">
    <i class="ti ${icon}" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
    <span style="font-size:12px;color:var(--text-secondary);width:90px;flex-shrink:0">${label}</span>
    <span style="font-size:12px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(value))}</span>
  </div>`
}

// hwRow avec HTML brut pour la valeur (ex : badge coloré)
function hwRowRaw(icon, label, html) {
  if (!html) return ''
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:0.5px solid var(--border)">
    <i class="ti ${icon}" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
    <span style="font-size:12px;color:var(--text-secondary);width:90px;flex-shrink:0">${label}</span>
    <span style="font-size:12px;font-weight:500;flex:1;min-width:0">${html}</span>
  </div>`
}

function complianceBadge(state) {
  const map = {
    compliant:     { text: '✓ Conforme',     color: 'var(--green)' },
    noncompliant:  { text: '✗ Non conforme', color: 'var(--red)'   },
    unknown:       { text: '? Inconnu',       color: 'var(--text-tertiary)' },
    configManager: { text: 'Config Manager',  color: 'var(--blue)'  },
  }
  const m = map[state]
  if (!m) return esc(state)
  return `<span style="color:${m.color}">${m.text}</span>`
}

function formatJoinType(jt) {
  const map = {
    azureADJoined:       'Azure AD Joint',
    hybridAzureADJoined: 'Hybrid Azure AD',
    azureADRegistered:   'Azure AD Enregistré',
  }
  return map[jt] || jt
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function initials(str) {
  return (str || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

function fmtBytes(b) {
  b = Number(b) || 0
  if (b <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`
}

function mBwPanel(bw) {
  if (!bw) return ''
  const { summary: s, series } = bw
  const hasSummary = s && (s.sent_7d || s.recv_7d)
  const hasSeries  = series && series.length > 1
  if (!hasSummary && !hasSeries) return ''

  let graphHtml = ''
  if (hasSeries) {
    const W = 320, H = 70, PL = 38, PR = 4, PT = 6, PB = 4
    const GW = W - PL - PR, GH = H - PT - PB
    const maxVal = Math.max(...series.map(p => Math.max(p.ds || 0, p.dr || 0)), 1)
    const tMin = new Date(series[0].t).getTime()
    const tMax = new Date(series[series.length - 1].t).getTime() || tMin + 1
    const cx = t => PL + ((new Date(t).getTime() - tMin) / (tMax - tMin)) * GW
    const cy = v => PT + GH - ((v || 0) / maxVal) * GH
    const yAxis = [maxVal, 0].map(v => {
      const yp = cy(v).toFixed(1)
      return `<line x1="${PL}" y1="${yp}" x2="${W - PR}" y2="${yp}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>
              <text x="${PL - 3}" y="${yp}" text-anchor="end" dominant-baseline="middle" fill="var(--text-tertiary)" font-size="8">${fmtBytes(v)}</text>`
    }).join('')
    const areaPath = key => {
      const pts = series.map(p => [cx(p.t), cy(p[key] || 0)])
      return `M${pts[0][0].toFixed(1)},${(PT + GH).toFixed(1)} ` +
        pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
        ` L${pts[pts.length - 1][0].toFixed(1)},${(PT + GH).toFixed(1)} Z`
    }
    const linePath = key =>
      series.map((p, i) => `${i === 0 ? 'M' : 'L'}${cx(p.t).toFixed(1)},${cy(p[key] || 0).toFixed(1)}`).join(' ')
    const t0 = new Date(series[0].t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const t1 = new Date(series[series.length - 1].t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    graphHtml = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
        ${yAxis}
        <path d="${areaPath('dr')}" fill="var(--green)" opacity=".25"/>
        <path d="${linePath('dr')}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${areaPath('ds')}" fill="var(--blue)" opacity=".25"/>
        <path d="${linePath('ds')}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary);margin-top:2px;padding:0 ${PR}px 0 ${PL}px">
        <span>${t0}</span>
        <span style="display:flex;gap:8px">
          <span style="color:var(--green)">↓ recv</span>
          <span style="color:var(--blue)">↑ sent</span>
        </span>
        <span>${t1}</span>
      </div>`
  }

  let cardsHtml = ''
  if (hasSummary) {
    const periods = [
      { label: '4h',  sent: s.sent_4h,  recv: s.recv_4h  },
      { label: '24h', sent: s.sent_24h, recv: s.recv_24h },
      { label: '7j',  sent: s.sent_7d,  recv: s.recv_7d  },
    ]
    cardsHtml = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:${hasSeries ? '8px' : '0'}">
        ${periods.map(p => `
          <div style="background:var(--bg-secondary);border-radius:8px;padding:7px;text-align:center">
            <div style="font-size:10px;color:var(--text-tertiary);margin-bottom:3px">${p.label}</div>
            <div style="font-size:10px;color:var(--green)">↓ ${fmtBytes(p.recv)}</div>
            <div style="font-size:10px;color:var(--blue)">↑ ${fmtBytes(p.sent)}</div>
          </div>`).join('')}
      </div>`
  }

  return `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-chart-bar"></i> Bande passante</div>
      <div style="padding:10px 12px 12px">
        ${graphHtml}
        ${cardsHtml}
      </div>
    </div>`
}

function mPingPanel(pings) {
  if (!Array.isArray(pings) || !pings.length) return ''
  return pings.map(ping => {
    if (!ping?.series?.length) return ''
    const series  = ping.series
    const allMs   = series.map(p => p.ms).filter(v => v !== null)
    if (!allMs.length) return ''

    const W = 320, H = 60, PL = 38, PR = 4, PT = 6, PB = 4
    const GW = W - PL - PR, GH = H - PT - PB
    const maxMs = Math.max(...allMs) || 1
    const minMs = Math.min(...allMs)
    const span  = maxMs - minMs || 1
    const tMin  = new Date(series[0].t).getTime()
    const tMax  = new Date(series[series.length - 1].t).getTime() || tMin + 1
    const cx = t  => PL + ((new Date(t).getTime() - tMin) / (tMax - tMin || 1)) * GW
    const cy = ms => ms === null ? null : PT + GH - ((ms - minMs) / span) * GH
    const yAxis = [maxMs, minMs].map(v => {
      const yp = (PT + GH - ((v - minMs) / span) * GH).toFixed(1)
      return `<line x1="${PL}" y1="${yp}" x2="${W - PR}" y2="${yp}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>
              <text x="${PL - 3}" y="${yp}" text-anchor="end" dominant-baseline="middle" fill="var(--text-tertiary)" font-size="8">${v} ms</text>`
    }).join('')
    const validPts = series.map(p => ({ x: cx(p.t), y: cy(p.ms) })).filter(p => p.y !== null)
    const path  = validPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    const dots  = series.map(p => {
      if ((p.loss || 0) > 0)
        return `<circle cx="${cx(p.t).toFixed(1)}" cy="${(PT + GH / 2).toFixed(1)}" r="3" fill="var(--red)" opacity=".8"/>`
      const y = cy(p.ms)
      if (y === null) return ''
      return `<circle cx="${cx(p.t).toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="var(--blue)" opacity=".5"/>`
    }).join('')
    const t0 = new Date(series[0].t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const t1 = new Date(series[series.length - 1].t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' })

    const sum = ping.summary || {}
    const periods = [
      { label: '4h',  s: sum['4h']  },
      { label: '24h', s: sum['24h'] },
      { label: '7j',  s: sum['7d']  },
    ]

    return `
      <div class="m-panel">
        <div class="m-panel-header"><i class="ti ti-wave-sine"></i> Ping ${esc(ping.host)}</div>
        <div style="padding:10px 12px 12px">
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
            ${yAxis}
            <path d="${path}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round"/>
            ${dots}
          </svg>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary);margin-top:2px;padding:0 ${PR}px 0 ${PL}px">
            <span>${t0}</span>
            <span style="color:var(--red);font-size:9px">● perte</span>
            <span>${t1}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">
            ${periods.map(({ label, s }) => s ? `
              <div style="background:var(--bg-secondary);border-radius:8px;padding:7px;text-align:center">
                <div style="font-size:10px;color:var(--text-tertiary);margin-bottom:2px">${label}</div>
                <div style="font-size:11px;font-weight:600">${s.avg_ms ?? '—'} ms</div>
                <div style="font-size:9px;color:${s.loss_pct > 0 ? 'var(--red)' : 'var(--green)'}">${s.loss_pct}% · max ${s.max_ms ?? '—'}</div>
              </div>` : '').join('')}
          </div>
        </div>
      </div>`
  }).join('')
}
