export async function renderUserDetail(container, id) {
  container.innerHTML = `
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:10px">
        <a href="#/users" class="btn btn-sm"><i class="ti ti-arrow-left"></i></a>
        <h1 class="topbar-title" id="ud-name">…</h1>
      </div>
    </div>
    <div id="ud-body" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  let user
  try {
    user = await window.api.getUser(id)
  } catch {
    showToast(t('error.generic'), 'error')
    return
  }

  document.getElementById('ud-name').textContent = user.display_name || '—'

  const ini = (user.display_name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  const d   = user.device

  const body = document.getElementById('ud-body')
  body.innerHTML = `
    <div class="pd-grid">
      <!-- Colonne gauche -->
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Identité -->
        <div class="panel">
          <div class="panel-header">${t('user.identity')}</div>
          <div style="padding:16px;display:flex;align-items:center;gap:16px">
            <div id="ud-avatar" class="ud-avatar">${esc(ini)}</div>
            <div style="min-width:0">
              <div style="font-size:15px;font-weight:600;margin-bottom:2px">${esc(user.display_name || '—')}</div>
              ${user.job_title  ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">${esc(user.job_title)}</div>` : ''}
              ${user.department ? `<div style="font-size:12px;color:var(--text-tertiary)"><i class="ti ti-building" style="margin-right:4px"></i>${esc(user.department)}</div>` : ''}
              <a href="mailto:${esc(user.email)}" style="font-size:12px;color:var(--blue);text-decoration:none;display:block;margin-top:4px">${esc(user.email || '')}</a>
            </div>
          </div>
        </div>

        <!-- Appareil -->
        ${d ? `
        <div class="panel">
          <div class="panel-header">
            ${t('user.device')}
            <a href="#/postes/${esc(d.id)}" style="font-size:11px;color:var(--blue)">${t('poste.see_all')}</a>
          </div>
          <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:center;gap:8px">
              <i class="ti ti-device-laptop" style="font-size:16px;color:var(--text-tertiary)"></i>
              <span style="font-weight:600;font-size:13px">${esc(d.hostname)}</span>
              <span class="badge badge-${deviceStatusColor(d)}">${t('status.' + deviceStatus(d))}</span>
            </div>
            <div class="hw-grid" style="padding:0">
              ${d.os          ? hwRow('ti-brand-windows', t('poste.hw.os'),        d.os)           : ''}
              ${d.model       ? hwRow('ti-device-laptop', t('poste.hw.model'),     d.model)        : ''}
              ${d.ram_gb      ? hwRow('ti-layers-intersect', t('poste.hw.ram'),    d.ram_gb + ' Go') : ''}
              ${d.last_seen   ? hwRow('ti-clock',         t('poste.hw.last_seen'), formatRelative(d.last_seen)) : ''}
              ${d.ip_netbird  ? hwRow('ti-network',       'Netbird IP',            d.ip_netbird)   : ''}
            </div>
            ${d.disk_used_pct != null ? diskBar(d) : ''}
          </div>
        </div>` : `
        <div class="panel">
          <div class="panel-header">${t('user.device')}</div>
          <div class="empty-state" style="padding:1.5rem">
            <i class="ti ti-device-laptop-off"></i>
            <p>${t('users.no_device')}</p>
          </div>
        </div>`}

      </div>
      <!-- Colonne droite -->
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Tickets récents -->
        <div class="panel">
          <div class="panel-header">
            ${t('poste.tickets')}
            <a href="#/tickets" style="font-size:11px;color:var(--blue)">${t('poste.see_all')}</a>
          </div>
          ${user.tickets?.length ? user.tickets.map(tk => `
            <div class="ticket-item" onclick="navigateTo('/tickets')" style="cursor:pointer">
              <div class="ti-header">
                <span class="ti-title">${esc(tk.title)}</span>
                <span class="badge badge-${tk.status === 'resolved' ? 'green' : 'orange'}">${esc(tk.status)}</span>
              </div>
              <div class="ti-meta">
                <span class="badge badge-${prioBadge(tk.priority)}">${esc(tk.priority)}</span>
                <span>${formatRelative(tk.created_at)}</span>
              </div>
            </div>`).join('')
            : `<div class="empty-state" style="padding:1rem"><p>${t('poste.no_tickets')}</p></div>`}
        </div>

      </div>
    </div>`

  // Charger la photo en arrière-plan
  loadAvatar(id, ini)
}

async function loadAvatar(id, ini) {
  const el = document.getElementById('ud-avatar')
  if (!el) return
  const url = await window.api.fetchUserPhoto(id).catch(() => null)
  if (!url || !document.getElementById('ud-avatar')) return
  el.innerHTML  = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
  el.style.background = 'transparent'
  el.style.color = 'transparent'
}

function hwRow(icon, label, value) {
  return `<div class="hw-row">
    <i class="ti ${icon}"></i>
    <span class="hw-label">${label}</span>
    <span class="hw-value">${esc(String(value))}</span>
  </div>`
}

function diskBar(d) {
  const pct   = d.disk_used_pct ?? 0
  const color = pct >= 90 ? 'red' : pct >= 80 ? 'orange' : 'green'
  const total = d.disk_total_gb ? ` · ${d.disk_total_gb} Go` : ''
  return `<div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px">
      <span style="color:var(--text-secondary)">Disque C:</span>
      <span style="color:var(--${color});font-weight:600">${pct}%${total}</span>
    </div>
    <div class="qty-bar" style="height:5px">
      <div class="qb ${color === 'red' ? 'danger' : color === 'orange' ? 'warn' : ''}" style="width:${pct}%"></div>
    </div>
  </div>`
}

function deviceStatus(d) {
  if (!d.last_seen) return 'offline'
  const age = Date.now() - new Date(d.last_seen).getTime()
  if (age > 3_600_000) return 'offline'
  if (d.disk_used_pct >= 90) return 'critical'
  if (d.disk_used_pct >= 80) return 'warn'
  return 'online'
}
function deviceStatusColor(d) {
  const s = deviceStatus(d)
  return s === 'online' ? 'green' : s === 'critical' ? 'red' : s === 'warn' ? 'orange' : 'gray'
}

function prioBadge(p) {
  return p === 'critical' ? 'red' : p === 'high' ? 'orange' : p === 'low' ? 'gray' : 'blue'
}
