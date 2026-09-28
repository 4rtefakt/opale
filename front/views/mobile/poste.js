import { getLocale } from '/i18n.js'

let _device = null
const LOC = () => getLocale() === 'en' ? 'en-GB' : 'fr-FR'

export async function renderPoste(el, id) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="window.location.hash='#/postes'">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 id="m-poste-title">…</h1>
      <span id="m-poste-badge"></span>
    </div>
    <div class="m-scroll" id="m-poste-body" style="padding-top:4px">
      <div class="m-loading-row"><div class="m-spinner"></div></div>
    </div>`

  try {
    _device = await window.api.getDevice(id)
    renderBody(el)
  } catch (err) {
    document.getElementById('m-poste-body').innerHTML = mErrorBox(err.message, () => renderPoste(el, id))
  }
}

function renderBody(el) {
  const d = _device
  document.getElementById('m-poste-title').textContent = d.hostname

  const pillCls = d.status === 'online' ? 'on' : d.status === 'critical' ? 'crit' : d.status === 'warn' ? 'warn' : 'off'
  const pillKey = d.status === 'online' ? 'mobile.device.status.online'
                : d.status === 'critical' ? 'mobile.device.status.critical'
                : d.status === 'warn' ? 'mobile.device.status.warn'
                : 'mobile.device.status.offline'
  const pillTxt = t(pillKey)
  document.getElementById('m-poste-badge').outerHTML =
    `<span id="m-poste-badge" class="m-pill m-pill-${pillCls}">${pillTxt}</span>`

  const pct = parseFloat(d.disk_used_pct) || 0
  const diskColor = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
  const body = document.getElementById('m-poste-body')
  body.innerHTML = `
    <!-- Les faits d'abord : qui, quoi, vu quand, disque -->
    <div class="m-facts" style="padding:0">
      <div class="m-fact">
        <span class="k">${esc(t('poste.user'))}</span>
        <span class="v ${d.user?.name ? '' : 'empty'}"><i class="ti ti-user"></i>${esc(d.user?.name || '—')}</span>
      </div>
      <div class="m-fact">
        <span class="k">${esc(t('poste.hw.model'))}</span>
        <span class="v ${d.model ? '' : 'empty'}"><i class="ti ti-device-laptop"></i>${esc(d.model || d.manufacturer || '—')}</span>
      </div>
      <div class="m-fact">
        <span class="k">${esc(t('poste.hw.last_seen'))}</span>
        <span class="v"><i class="ti ti-clock"></i>${esc(formatRelative(d.last_seen))}</span>
      </div>
      <div class="m-fact">
        <span class="k">${esc(t('poste.disks'))}</span>
        <span class="v" style="color:${pct ? diskColor : 'inherit'}"><i class="ti ti-database"></i>${pct ? pct + ' %' : '—'}</span>
      </div>
    </div>

    <!-- Actions rapides -->
    <div class="m-action-grid">
      ${d.ip_netbird && d.status === 'online' ? `
      <button class="m-action-btn" onclick="mConfirmSSH()">
        <i class="ti ti-terminal"></i>
        <span>SSH</span>
      </button>` : `
      <button class="m-action-btn" disabled title="${esc(d.ip_netbird ? t('mobile.device.status.offline') : 'Netbird')}">
        <i class="ti ti-terminal"></i>
        <span>SSH</span>
      </button>`}
      <button class="m-action-btn" onclick="mOpenNewTicket()">
        <i class="ti ti-ticket"></i>
        <span>${esc(t('mobile.poste.act.ticket'))}</span>
      </button>
      <button class="m-action-btn" onclick="mForceCheckin(this)">
        <i class="ti ti-refresh"></i>
        <span>${esc(t('mobile.poste.act.checkin'))}</span>
      </button>
      <button class="m-action-btn" onclick="mSyncDevice(this)">
        <i class="ti ti-brand-azure"></i>
        <span>Intune</span>
      </button>
      <button class="m-action-btn" onclick="mRunScript()">
        <i class="ti ti-player-play"></i>
        <span>${esc(t('mobile.poste.act.script'))}</span>
      </button>
      ${(window.appState?.user?.isAdmin && d.laps) ? `
      <button class="m-action-btn" onclick="mOpenLaps()">
        <i class="ti ti-key"></i>
        <span>${t('mobile.poste.laps.action')}</span>
      </button>` : ''}
    </div>

    <!-- Alertes actives : en premier, c'est ce qui demande une action -->
    ${(d.active_alerts || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-alert-triangle" style="color:var(--red)"></i> ${esc(t('poste.alerts'))}</div>
      ${d.active_alerts.map(a => `
        <div class="m-kv" style="flex-direction:column;align-items:flex-start;gap:2px">
          <span style="font-weight:500">${esc(a.message || a.type)}</span>
          <span class="m-muted" style="font-size:11.5px">${formatRelative(a.created_at)}</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Utilisateur -->
    ${d.user ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-user"></i> ${esc(t('poste.user'))}</div>
      <div style="display:flex;align-items:center;gap:12px;padding:12px 14px">
        <div class="m-av">${initials(d.user.name)}</div>
        <div style="min-width:0">
          <div style="font-weight:500;font-size:14px">${esc(d.user.name || '—')}</div>
          ${d.user.job_title ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(d.user.job_title)}</div>` : ''}
          ${d.user.email ? `<div style="font-size:11.5px;color:var(--blue-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.user.email)}</div>` : ''}
        </div>
      </div>
    </div>` : ''}

    <!-- Sécurité (état des protections : lisible d'un coup d'œil) -->
    ${mSecurityPanel(d)}

    <!-- Matériel & identité Intune : repliés, détail rarement utile -->
    <details class="m-details">
      <summary><i class="ti ti-device-laptop"></i> ${esc(t('poste.hardware'))} <span class="n">${esc([d.manufacturer, d.os].filter(Boolean).join(' · '))}</span><i class="ti ti-chevron-down chev"></i></summary>
      ${hwRow('ti-building-factory-2', t('poste.hw.manufacturer'), d.manufacturer)}
      ${hwRow('ti-device-laptop',      t('poste.hw.model'),        d.model)}
      ${hwRow('ti-cpu',                t('poste.hw.cpu'),          d.cpu)}
      ${hwRow('ti-layers-intersect',   t('poste.hw.ram'),          d.ram_gb ? d.ram_gb + ' Go' : null)}
      ${hwRow('ti-brand-windows',      t('poste.hw.os'),           d.os)}
      ${hwRow('ti-hash',               t('poste.hw.os_build'),     d.os_build)}
      ${hwRow('ti-settings',           t('poste.hw.bios'),         d.bios_version)}
      ${hwRow('ti-fingerprint',        t('poste.hw.serial'),       d.serial)}
      ${d.ip_netbird ? hwRowRaw('ti-network', 'Netbird', `<span style="color:var(--blue-text)" onclick="navigator.clipboard.writeText(${jsArg(d.ip_netbird)}).then(()=>window.showToast(t('mobile.poste.ip_copied'),'success'))">${esc(d.ip_netbird)}</span>`) : ''}
      ${d.compliance_state ? hwRowRaw('ti-shield-check', t('poste.hw.compliance'), complianceBadge(d.compliance_state)) : ''}
      ${hwRow('ti-cloud',              t('poste.hw.join_type'),    d.join_type ? formatJoinType(d.join_type) : null)}
      ${d.enrolled_at      ? hwRow('ti-calendar-plus', t('poste.hw.enrolled'),    fmtDate(d.enrolled_at))      : ''}
      ${d.intune_last_sync ? hwRow('ti-refresh',       t('poste.hw.intune_sync'), fmtDate(d.intune_last_sync)) : ''}
    </details>

    ${mPerfPanel(d)}

    <!-- Disques -->
    ${(d.disks || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-database"></i> ${esc(t('poste.disks'))}</div>
      <div style="padding:2px 14px 12px">
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
    <details class="m-details">
      <summary><i class="ti ti-network"></i> ${esc(t('poste.network'))} <span class="n">${d.network.length}</span><i class="ti ti-chevron-down chev"></i></summary>
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
    </details>` : ''}

    <!-- Bande passante -->
    ${mBwPanel(d.bandwidth)}

    <!-- Ping -->
    ${mPingPanel(d.ping)}

    <!-- Tickets ouverts -->
    ${(d.tickets || []).length ? `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-ticket"></i> ${esc(t('poste.tickets'))}</div>
      ${d.tickets.map(tk => `
        <button class="m-row" onclick="window.location.hash='#/ticket/${esc(tk.id)}'">
          <i class="ti ti-ticket"></i>
          <span class="main"><span class="ttl">${esc(tk.title)}</span><span class="sub">${formatRelative(tk.created_at)}</span></span>
          <span class="end"><span class="m-pill ${tk.status === 'resolved' ? 'm-pill-on' : tk.status === 'in_progress' ? 'm-pill-warn' : 'm-pill-off'}">${esc(t('tickets.status.' + (['open','in_progress','resolved','closed'].includes(tk.status) ? tk.status : 'open')))}</span><i class="ti ti-chevron-right chev"></i></span>
        </button>`).join('')}
    </div>` : ''}

    <!-- Scripts à distance -->
    <div class="m-panel" id="m-exec-panel">
      <div class="m-panel-header">
        <i class="ti ti-terminal-2"></i> ${esc(t('mobile.nav.route.scripts'))}
        <button class="m-icon-btn sm" onclick="mRunScript()" title="${esc(t('mobile.poste.run_script'))}"><i class="ti ti-player-play"></i></button>
      </div>
      <div id="m-exec-history">
        <div class="m-loading-row"><div class="m-spinner"></div></div>
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
      <div class="m-sheet-title"><i class="ti ti-terminal"></i> ${esc(t('mobile.poste.ssh.title'))}</div>
      <div style="padding:12px 0 4px;display:flex;flex-direction:column;gap:12px">
        <div style="background:var(--amber-bg);border-radius:var(--radius-sm);padding:12px;font-size:12.5px;color:var(--amber);line-height:1.5">
          <strong>${esc(t('mobile.poste.ssh.warn_title'))}</strong><br>${esc(t('mobile.poste.ssh.warn'))}
        </div>
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5">
          ${esc(t('mobile.poste.ssh.target'))} : <strong style="color:var(--text-primary)">${esc(d.hostname)}</strong> — ${esc(d.ip_netbird)}
        </div>
        <button class="m-btn-primary" onclick="window.mCloseSheet();window.location.hash='#/ssh/${esc(d.id)}'">
          <i class="ti ti-browser"></i> ${esc(t('mobile.poste.ssh.browser'))}
        </button>
        <button class="m-btn block" onclick="navigator.clipboard.writeText(${jsArg(sshCmd)}).then(()=>{window.mCloseSheet();window.showToast(t('mobile.poste.ssh.copied'),'success')})">
          <i class="ti ti-terminal-2"></i> ${esc(t('mobile.poste.ssh.terminal'))}
        </button>
        <button class="m-btn ghost block" onclick="window.mCloseSheet()">${esc(t('btn.cancel'))}</button>
      </div>`)
  }

  // Nouveau ticket : la feuille complète de la liste, préremplie avec ce poste.
  window.mOpenNewTicket = async () => {
    const { mNewTicket } = await import('/views/mobile/tickets.js')
    mNewTicket({ device: { id: d.id, hostname: d.hostname } })
  }

  // Anti double-submit : withBusy désactive le bouton + spinner pendant l'appel,
  // ce qui empêche les doubles audit_logs / actions sur le même PC.
  window.mForceCheckin = (btn) => withBusy(btn, async () => {
    try {
      const res = await window.api.forceCheckinDevices([d.id])
      if (res.errors?.length) window.showToast(res.errors[0], 'error')
      else window.showToast(t('mobile.poste.toast.checkin'), 'success')
    } catch { window.showToast(t('mobile.common.error'), 'error') }
  })

  window.mSyncDevice = (btn) => withBusy(btn, async () => {
    try {
      await window.api.forceSyncDevices([d.id])
      window.showToast(t('mobile.dashboard.toast.sync_started'), 'success')
    } catch { window.showToast(t('mobile.common.error'), 'error') }
  })

  window.mRunScript = async () => {
    let scripts = []
    try { scripts = await window.api.getScripts() } catch {}
    if (!scripts.length) { window.showToast(t('mobile.postes.bulk.scripts.empty'), 'error'); return }
    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-player-play" style="color:var(--green)"></i> ${esc(t('mobile.poste.run_script'))}</div>
      <div style="padding:12px 0 0">
        <div class="m-label">${esc(t('mobile.postes.bulk.scripts.choose'))}</div>
        <select class="m-input" id="m-run-script-sel">
          ${scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.category ? ` (${esc(s.category)})` : ''}</option>`).join('')}
        </select>
        <p class="m-muted" style="font-size:12px;margin:10px 0">${esc(t('mobile.postes.bulk.scripts.delay'))}</p>
        <button class="m-btn-primary" style="margin-top:4px" onclick="mSubmitRunScript(this)"><i class="ti ti-player-play"></i> ${esc(t('mobile.postes.bulk.scripts.confirm'))}</button>
      </div>`)
    window.mSubmitRunScript = async (btn) => {
      const scriptId = document.getElementById('m-run-script-sel')?.value
      if (!scriptId) return
      await withBusy(btn, async () => {
        try {
          await window.api.runScript(scriptId, d.id)
          window.mCloseSheet()
          window.showToast(t('mobile.poste.toast.script_queued'), 'success')
          loadExecHistory(d.id)
        } catch { window.showToast(t('mobile.common.error'), 'error') }
      })
    }
  }

  // ── LAPS / compte de récupération (admin-only, données sensibles) ────────────
  // Le mot de passe n'est jamais affiché d'emblée : il faut « Révéler » (appel
  // getAdminCredential qui journalise l'accès côté serveur), puis il s'efface
  // automatiquement après 30s. Même sémantique que le desktop (front/views/poste.js).
  window.mOpenLaps = () => {
    const l = d.laps
    if (!l) return
    const metaRow = (icon, label, value) => value ? `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:0.5px solid var(--border)">
        <i class="ti ${icon}" style="font-size:14px;color:var(--text-tertiary);width:16px;text-align:center;flex-shrink:0"></i>
        <span style="font-size:11px;color:var(--text-secondary);flex:1">${label}</span>
        <span style="font-size:12px;font-weight:500">${value}</span>
      </div>` : ''
    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-key" style="margin-right:6px"></i>${t('mobile.poste.laps.title')}
        <span class="m-pill" style="margin-left:8px;font-size:10px">${t('mobile.poste.laps.admin')}</span>
      </div>
      <div style="padding:0 4px;display:flex;flex-direction:column;gap:12px">
        <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:12px;font-size:12px;color:var(--amber);line-height:1.5">
          ${t('mobile.poste.laps.warning')}
        </div>
        <div>
          ${metaRow('ti-user-shield', t('mobile.poste.laps.username'), esc(l.username))}
          ${l.password_changed_at ? metaRow('ti-calendar-time', t('mobile.poste.laps.last_rotation'), esc(formatRelative(l.password_changed_at))) : ''}
          ${l.last_viewed_at ? metaRow('ti-eye', t('mobile.poste.laps.last_access'), esc(formatRelative(l.last_viewed_at)) + (l.last_viewed_by_name ? ` <span style="color:var(--text-tertiary)">${esc(l.last_viewed_by_name)}</span>` : '')) : ''}
          ${l.rotation_requested_at ? metaRow('ti-refresh', t('mobile.poste.laps.rotation_requested'), `<span style="color:var(--amber)">${esc(formatRelative(l.rotation_requested_at))}</span>`) : ''}
        </div>
        <div id="m-laps-pwd-zone">
          <button class="m-btn-primary" onclick="mLapsReveal(this)">
            <i class="ti ti-eye"></i> ${t('mobile.poste.laps.reveal')}
          </button>
        </div>
        <button style="width:100%;padding:13px;border-radius:10px;font-size:14px;font-weight:600;background:var(--bg-tertiary);color:var(--amber);border:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px" onclick="mLapsRotate(this)">
          <i class="ti ti-refresh"></i> ${t('mobile.poste.laps.rotate')}
        </button>
        <button style="width:100%;padding:10px;border-radius:10px;font-size:13px;font-weight:500;background:none;border:1px solid var(--border);color:var(--text-secondary);cursor:pointer" onclick="window.mCloseSheet()">
          ${t('mobile.poste.laps.close')}
        </button>
      </div>`)
  }

  window.mLapsReveal = (btn) => withBusy(btn, async () => {
    try {
      const cred = await window.api.getAdminCredential(d.id)
      const zone = document.getElementById('m-laps-pwd-zone')
      if (!zone) return
      let remaining = 30
      zone.innerHTML = `
        <div class="m-label">${t('mobile.poste.laps.password')}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="m-input" id="m-laps-pwd" readonly type="password" style="font-family:monospace;letter-spacing:.1em;flex:1">
          <button class="m-icon-btn" onclick="mLapsToggle()"><i class="ti ti-eye" id="m-laps-eye"></i></button>
          <button class="m-icon-btn" onclick="mLapsCopy()"><i class="ti ti-copy"></i></button>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);text-align:center;background:var(--bg-secondary);border-radius:8px;padding:6px;margin-top:8px">
          ${t('mobile.poste.laps.autoclear', { s: '<span id="m-laps-countdown">30</span>' })}
        </div>`
      // Valeur injectée via DOM (jamais dans l'HTML) — évite toute fuite via innerHTML.
      const field = document.getElementById('m-laps-pwd')
      if (field) field.value = cred.password
      window.mLapsToggle = () => {
        const f = document.getElementById('m-laps-pwd')
        const eye = document.getElementById('m-laps-eye')
        if (!f) return
        f.type = f.type === 'password' ? 'text' : 'password'
        if (eye) eye.className = `ti ti-eye${f.type === 'text' ? '-off' : ''}`
      }
      window.mLapsCopy = () => {
        navigator.clipboard.writeText(cred.password)
          .then(() => window.showToast(t('mobile.poste.laps.copied'), 'success'))
      }
      const iv = setInterval(() => {
        remaining--
        const cd = document.getElementById('m-laps-countdown')
        if (cd) cd.textContent = remaining
        // Stop si le sheet est fermé/remplacé ou le délai écoulé → on efface.
        if (remaining <= 0 || !document.getElementById('m-laps-pwd')) {
          clearInterval(iv)
          const f = document.getElementById('m-laps-pwd')
          if (f) f.value = ''
          const z = document.getElementById('m-laps-pwd-zone')
          if (z) z.innerHTML = `
            <button class="m-btn-primary" onclick="mLapsReveal(this)">
              <i class="ti ti-eye"></i> ${t('mobile.poste.laps.reveal')}
            </button>`
        }
      }, 1000)
    } catch (err) {
      window.showToast(err.message || t('mobile.common.error'), 'error')
    }
  })

  window.mLapsRotate = (btn) => {
    if (!confirm(t('mobile.poste.laps.rotate_confirm'))) return
    return withBusy(btn, async () => {
      try {
        await window.api.rotateAdminCredential(d.id)
        window.mCloseSheet()
        window.showToast(t('mobile.poste.laps.rotate_toast'), 'success')
        _device = await window.api.getDevice(d.id)
        renderBody(el)
      } catch (err) {
        window.showToast(err.message || t('mobile.common.error'), 'error')
      }
    })
  }
}

// ── Historique d'exécutions ──────────────────────────────────────────────────

async function loadExecHistory(deviceId, offset = 0) {
  const el = document.getElementById('m-exec-history')
  if (!el) return
  try {
    const { rows, total, limit } = await window.api.getDeviceExecutions(deviceId, offset)
    if (!rows.length && offset === 0) {
      el.innerHTML = `<div style="text-align:center;padding:16px;font-size:12px;color:var(--text-tertiary)">${esc(t('mobile.poste.exec.empty'))}</div>`
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
          ${esc(t('mobile.poste.exec.more', { n: total - offset - limit }))}
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
  } catch (err) {
    const el2 = document.getElementById('m-exec-history')
    if (el2) el2.innerHTML = mErrorBox(err.message, () => loadExecHistory(deviceId, offset))
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
      `<span style="color:var(--${bl.enabled ? 'green' : 'red'})">${esc(t(bl.enabled ? 'mobile.poste.sec.enabled' : 'mobile.poste.sec.disabled'))}</span>${bl.encryption_method ? ' · ' + esc(bl.encryption_method) : ''}`
    ))
  }
  if ([def.antivirus_enabled, def.realtime_protection, def.antispyware_enabled].some(v => v !== undefined)) {
    rows.push(hwRowRaw('ti-shield', 'Defender',
      `${chk(def.antivirus_enabled)} AV · ${chk(def.realtime_protection)} RT · ${chk(def.antispyware_enabled)} AS`
    ))
  }
  if (fw.domain_enabled !== undefined) {
    rows.push(hwRowRaw('ti-wall', esc(t('mobile.poste.sec.firewall')),
      `${chk(fw.domain_enabled)} Dom · ${chk(fw.private_enabled)} Priv · ${chk(fw.public_enabled)} Pub`
    ))
  }
  if (hs.tpm_present !== undefined) {
    rows.push(hwRow('ti-microchip', 'TPM', t(hs.tpm_present ? 'mobile.poste.sec.present' : 'mobile.poste.sec.absent')))
  }
  if (hs.pending_reboot) {
    rows.push(hwRowRaw('ti-refresh-alert', esc(t('mobile.poste.sec.reboot')), `<span style="color:var(--amber);font-weight:500">${esc(t('mobile.poste.sec.reboot_pending'))}</span>`))
  }

  if (!rows.length) return ''

  return `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-shield-lock"></i> ${esc(t('mobile.poste.sec.title'))}</div>
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
            <span style="font-size:12px;color:var(--text-secondary);width:90px;flex-shrink:0">${esc(t('mobile.poste.perf.cpu_avg'))}</span>
            <span style="font-size:12px;font-weight:500">${esc(String(sp.cpu_avg_pct))}%</span>
            ${sp.cpu_max_pct != null ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:auto">max ${esc(String(sp.cpu_max_pct))}%</span>` : ''}
          </div>
          <div class="m-disk-bar" style="margin-left:24px"><div class="m-disk-bar-fill" style="width:${sp.cpu_avg_pct}%;background:${color}"></div></div>
        </div>`)
    }
    if (sp.uptime_seconds != null) {
      const days  = Math.floor(sp.uptime_seconds / 86400)
      const hours = Math.floor((sp.uptime_seconds % 86400) / 3600)
      rows.push(hwRow('ti-clock-hour-3', esc(t('mobile.poste.perf.uptime')), days > 0 ? `${days}j ${hours}h` : `${hours}h`))
    }
    if (sp.battery_pct != null) {
      const stat = sp.battery_status || ''
      const icon = stat === 'ac' || stat === 'full' ? 'ti-plug' :
                   stat === 'charging' ? 'ti-battery-charging' :
                   sp.battery_pct < 20 ? 'ti-battery-1' : 'ti-battery'
      const statLabel = stat ? batteryStatusLabel(stat) : ''
      rows.push(hwRow(icon, esc(t('mobile.poste.perf.battery')), `${sp.battery_pct}%${statLabel ? ' · ' + statLabel : ''}`))
    }
  }

  if (si?.current_user) rows.push(hwRow('ti-user', esc(t('mobile.poste.perf.logged_in')), si.current_user))

  if (!rows.length) return ''

  return `
    <div class="m-panel">
      <div class="m-panel-header"><i class="ti ti-activity"></i> ${esc(t('mobile.poste.perf.title'))}</div>
      ${rows.join('')}
    </div>`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hwRow(icon, label, value) {
  if (!value) return ''
  return `
  <div class="m-kv"><i class="ti ${icon}"></i><span class="k">${label}</span><span class="v">${esc(String(value))}</span></div>`
}

// hwRow avec HTML brut pour la valeur (ex : badge coloré)
function hwRowRaw(icon, label, html) {
  if (!html) return ''
  return `
  <div class="m-kv"><i class="ti ${icon}"></i><span class="k">${label}</span><span class="v" style="white-space:normal">${html}</span></div>`
}

function complianceBadge(state) {
  const map = {
    compliant:     { mark: '✓', color: 'var(--green)' },
    noncompliant:  { mark: '✗', color: 'var(--red)'   },
    unknown:       { mark: '?', color: 'var(--text-tertiary)' },
    configManager: { mark: '',  color: 'var(--blue-text)' },
  }
  const m = map[state]
  if (!m) return esc(state)
  return `<span style="color:${m.color}">${m.mark ? m.mark + ' ' : ''}${esc(t('compliance.state.' + state))}</span>`
}

function batteryStatusLabel(stat) {
  const key   = 'battery.status.' + stat
  const label = t(key)
  return label === key ? stat : label
}

function formatJoinType(jt) {
  return ['azureADJoined', 'hybridAzureADJoined', 'azureADRegistered'].includes(jt) ? t('mobile.poste.join.' + jt) : jt
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(LOC(), { day: '2-digit', month: '2-digit', year: 'numeric' })
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
    const t0 = new Date(series[0].t).toLocaleString(LOC(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const t1 = new Date(series[series.length - 1].t).toLocaleString(LOC(), { hour: '2-digit', minute: '2-digit' })
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
          <span style="color:var(--green)">↓ ${esc(t('mobile.poste.bw.recv'))}</span>
          <span style="color:var(--blue)">↑ ${esc(t('mobile.poste.bw.sent'))}</span>
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
      <div class="m-panel-header"><i class="ti ti-chart-bar"></i> ${esc(t('mobile.poste.bandwidth'))}</div>
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
    const t0 = new Date(series[0].t).toLocaleString(LOC(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const t1 = new Date(series[series.length - 1].t).toLocaleString(LOC(), { hour: '2-digit', minute: '2-digit' })

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
            <span style="color:var(--red);font-size:9px">● ${esc(t('mobile.poste.ping.loss'))}</span>
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
