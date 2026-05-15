// Vue Journal d'audit
let _offset = 0
let _total  = 0
let _timer  = null

// Catégories : chaque entrée définit soit `in` (actions visibles), soit
// `notIn` (actions masquées). Ordre = ordre du dropdown UI.
const _CATEGORIES = {
  default: {
    label: 'Tout sauf connexion agent',
    notIn: ['agent_ws_connect', 'agent_ws_disconnect', 'agent_checkin'],
  },
  all: {
    label: 'Toutes les actions',
  },
  remote: {
    label: 'Accès distants',
    in: ['agent_console_open', 'agent_console_close', 'agent_console_takeover', 'ssh_open', 'ssh_close'],
  },
  devices: {
    label: 'Gestion des postes',
    in: ['rmm_force_checkin', 'intune_force_sync', 'device_deleted', 'intune_sync'],
  },
  security: {
    label: 'Tokens & sécurité',
    in: ['token_created', 'token_revoked', 'agent_bootstrap_exchange', 'admin_granted', 'admin_revoked'],
  },
  agent_conn: {
    label: 'Connexion agent (bruyant)',
    in: ['agent_ws_connect', 'agent_ws_disconnect', 'agent_checkin', 'setup_script'],
  },
}

const _CATEGORY_STORAGE_KEY = 'audit:category'

export async function renderAudit(container) {
  const savedCategory = localStorage.getItem(_CATEGORY_STORAGE_KEY) || 'default'
  const catOptions = Object.entries(_CATEGORIES)
    .map(([key, c]) => `<option value="${key}"${key === savedCategory ? ' selected' : ''}>${esc(c.label)}</option>`)
    .join('')

  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('settings.audit.title')}</h1>
      <div class="topbar-actions" style="gap:6px">
        <select id="audit-filter-category" class="form-input" style="height:28px;font-size:12px;padding:0 8px" onchange="auditOnCategoryChange()">
          ${catOptions}
        </select>
        <select id="audit-filter-level" class="form-input" style="height:28px;font-size:12px;padding:0 8px" onchange="auditLoad()">
          <option value="">${t('audit.filter.all_levels')}</option>
          <option value="info">${t('audit.level.info')}</option>
          <option value="warn">${t('audit.level.warn')}</option>
          <option value="error">${t('audit.level.error')}</option>
        </select>
        <button class="btn btn-sm" id="audit-auto-refresh" onclick="auditToggleRefresh()" title="${t('audit.btn.auto_refresh_title')}">
          <i class="ti ti-refresh"></i> ${t('audit.btn.auto_refresh')}
        </button>
      </div>
    </div>
    <div id="audit-body" style="flex:1;overflow-y:auto">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>
    <div id="audit-footer" style="padding:8px 16px;font-size:11px;color:var(--text-tertiary);border-top:0.5px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
      <span id="audit-count"></span>
      <button class="btn btn-sm" id="audit-load-more" style="display:none" onclick="auditLoadMore()">${t('audit.load_more')}</button>
    </div>`

  window.auditLoad             = auditLoad
  window.auditLoadMore         = auditLoadMore
  window.auditToggleRefresh    = auditToggleRefresh
  window.auditToggleRow        = auditToggleRow
  window.auditOnCategoryChange = auditOnCategoryChange

  await auditLoad()
}

function auditOnCategoryChange() {
  const cat = document.getElementById('audit-filter-category')?.value || 'default'
  localStorage.setItem(_CATEGORY_STORAGE_KEY, cat)
  auditLoad()
}

async function auditLoad() {
  _offset = 0
  const body = document.getElementById('audit-body')
  if (!body) return
  body.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>`
  await _fetch(false)
}

async function auditLoadMore() {
  _offset += 50
  await _fetch(true)
}

async function _fetch(append) {
  const cat   = document.getElementById('audit-filter-category')?.value || 'default'
  const level = document.getElementById('audit-filter-level')?.value    || null
  const def   = _CATEGORIES[cat] || _CATEGORIES.default
  const params = {
    level,
    limit:  50,
    offset: _offset,
    actions_in:     def.in    ? def.in.join(',')    : null,
    actions_not_in: def.notIn ? def.notIn.join(',') : null,
  }
  try {
    const data = await window.api.getAudit(params)
    _total = data.total
    _renderRows(data.rows, append)
    const countEl = document.getElementById('audit-count')
    if (countEl) countEl.textContent = t('audit.count', { n: Math.min(_offset + data.rows.length, _total), total: _total })
    const moreBtn = document.getElementById('audit-load-more')
    if (moreBtn) moreBtn.style.display = (_offset + data.rows.length < _total) ? '' : 'none'
  } catch {
    const body = document.getElementById('audit-body')
    if (body && !append) body.innerHTML = `<div class="empty-state"><p>${t('audit.error.load')}</p></div>`
  }
}

const _BADGE = {
  agent_checkin:             ['b-done',   'ti-device-laptop'],
  setup_script:              ['b-open',   'ti-script'],
  intune_sync:               ['b-open',   'ti-cloud-download'],
  intune_force_sync:         ['b-open',   'ti-cloud-download'],
  rmm_force_checkin:         ['b-open',   'ti-refresh'],
  device_deleted:            ['b-closed', 'ti-trash'],
  token_created:             ['b-prog',   'ti-key'],
  token_revoked:             ['b-prog',   'ti-key-off'],
  admin_granted:             ['b-prog',   'ti-shield-check'],
  admin_revoked:             ['b-prog',   'ti-shield-off'],
  agent_bootstrap_exchange:  ['b-done',   'ti-arrows-exchange'],
  agent_ws_connect:          ['b-done',   'ti-broadcast'],
  agent_ws_disconnect:       ['b-closed', 'ti-broadcast-off'],
  agent_console_open:        ['b-prog',   'ti-terminal-2'],
  agent_console_close:       ['b-done',   'ti-terminal-2'],
  agent_console_takeover:    ['b-prog',   'ti-hand-grab'],
  ssh_open:                  ['b-prog',   'ti-terminal'],
  ssh_close:                 ['b-done',   'ti-terminal'],
}

// Libellés FR pour les actions remontées dans les badges. Si absent,
// on tombe sur le nom brut de l'action (forward-compat).
const _ACTION_LABEL = {
  agent_console_open:     'console ouverte',
  agent_console_close:    'console fermée',
  agent_console_takeover: 'console reprise',
  ssh_open:               'ssh ouvert',
  ssh_close:              'ssh fermé',
  agent_ws_connect:       'agent connecté',
  agent_ws_disconnect:    'agent déconnecté',
  agent_checkin:          'checkin agent',
  rmm_force_checkin:      'forçage checkin',
  intune_force_sync:      'forçage sync intune',
  device_deleted:         'poste supprimé',
}

function _formatDuration(s) {
  if (s == null || !Number.isFinite(s)) return ''
  if (s < 60)    return `${s} s`
  if (s < 3600)  return `${Math.floor(s / 60)} min ${s % 60} s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h} h ${m} min`
}

// Rendu compact "motif: <category> — <note tronquée>" pour la ligne de
// résumé. Note tronquée à ~60 chars pour ne pas casser le layout — la
// version complète reste visible dans le panneau d'expansion (details JSON).
function _reasonShort(reason) {
  if (!reason || !reason.category) return ''
  const note = (reason.note || '').slice(0, 60)
  const ellipsis = (reason.note || '').length > 60 ? '…' : ''
  return note ? `motif: ${reason.category} — ${note}${ellipsis}` : `motif: ${reason.category}`
}

function _summary(action, details) {
  if (!details) return ''
  if (action === 'intune_sync')   return t('audit.summary.intune', { ok: details.upserted ?? 0, errors: details.errors ?? 0 })
  if (action === 'agent_checkin') {
    let s = t('audit.summary.agent_checkin', { disks: details.disks ?? 0 })
    if (details.ip_netbird) s += ' · ' + details.ip_netbird
    if (details.new)        s += ' · ' + t('audit.summary.new')
    return s
  }
  if (action === 'setup_script')  return details.level || ''
  if (action === 'agent_console_open')     return [_reasonShort(details.reason), details.shell, details.session_id?.slice(0, 8)].filter(Boolean).join(' · ')
  if (action === 'agent_console_close')    return [_formatDuration(details.duration_seconds), details.reason].filter(Boolean).join(' · ')
  if (action === 'agent_console_takeover') return details.taken_session ? `prise de la session ${details.taken_session.slice(0, 8)}` : ''
  if (action === 'ssh_open')               return [_reasonShort(details.reason), details.host, details.ip].filter(Boolean).join(' · ')
  if (action === 'ssh_close')              return _formatDuration(details.duration_seconds)
  if (action === 'agent_ws_disconnect')    return [details.reason, _formatDuration(details.duration_seconds)].filter(Boolean).join(' · ')
  return ''
}

function _renderRows(rows, append) {
  const body = document.getElementById('audit-body')
  if (!body) return
  if (!rows.length && !append) {
    body.innerHTML = `<div class="empty-state"><p>${t('audit.empty')}</p></div>`
    return
  }
  const html = rows.map((r, idx) => {
    let [badgeClass, icon] = _BADGE[r.action] || ['b-closed', 'ti-dots']
    if (r.action === 'intune_sync' && r.details?.errors > 0) badgeClass = 'b-prog'
    const level     = r.details?.level
    const levelColor = level === 'error' ? 'var(--red)' : level === 'warn' ? 'var(--amber)' : null
    const summary   = _summary(r.action, r.details)
    const hasLog    = !!r.details?.log
    const rowId     = `ar-${_offset}-${idx}`
    // Lien préfère entra_id (toujours présent dans users_cache) à email
    // (souvent vide tant que la sync Entra n'a pas tourné).
    const byUserId = r.by_user_entra_id || r.by_user_email
    const byUser = byUserId
      ? `<a href="#/users/${esc(byUserId)}" class="nav-link" onclick="event.stopPropagation()">${esc(r.by_user || '—')}</a>`
      : `<span style="color:var(--text-secondary)">${esc(r.by_user || '—')}</span>`
    let targetHtml = ''
    if (r.target) {
      // Pour agent_checkin, target = device_id (UUID) — on affiche le
      // hostname résolu côté API plutôt que l'UUID brut. Pour les autres
      // actions, target = hostname directement.
      const displayName = r.device_hostname || r.target
      const hostnameEl = r.device_id
        ? `<a href="#/postes/${esc(r.device_id)}" class="nav-link" onclick="event.stopPropagation()">${esc(displayName)}</a>`
        : `<span>${esc(displayName)}</span>`
      const assignedUserId = r.device_user_entra_id || r.device_user_email
      const assignedEl = assignedUserId && r.device_user_name
        ? ` <a href="#/users/${esc(assignedUserId)}" class="nav-link" style="color:var(--text-tertiary)" onclick="event.stopPropagation()">(${esc(r.device_user_name)})</a>`
        : r.device_user_name
          ? ` <span style="color:var(--text-tertiary)">(${esc(r.device_user_name)})</span>`
          : ''
      targetHtml = ` <span style="color:var(--text-tertiary)">→</span> ${hostnameEl}${assignedEl}`
    }
    return `
      <div class="audit-row">
        <div class="audit-row-main" onclick="auditToggleRow('${rowId}')">
          <span class="badge ${badgeClass}" style="min-width:110px;text-align:center"><i class="ti ${icon}"></i> ${esc(_ACTION_LABEL[r.action] || r.action)}</span>
          ${level && levelColor ? `<span style="font-size:10px;font-weight:600;color:${levelColor}">${level.toUpperCase()}</span>` : ''}
          <span class="audit-row-text">
            ${byUser}
            ${targetHtml}
            ${summary ? ` <span style="color:var(--text-tertiary)">· ${esc(summary)}</span>` : ''}
          </span>
          <span class="audit-row-time">${formatRelative(r.created_at)}</span>
          ${hasLog ? `<i class="ti ti-chevron-right audit-chevron" id="${rowId}-chevron"></i>` : ''}
        </div>
        ${hasLog ? `<div class="audit-row-detail hidden" id="${rowId}-detail">
          <pre>${esc(r.details.log)}</pre>
        </div>` : ''}
      </div>`
  }).join('')
  if (append) body.insertAdjacentHTML('beforeend', html)
  else        body.innerHTML = html
}

function auditToggleRow(rowId) {
  const detail  = document.getElementById(`${rowId}-detail`)
  const chevron = document.getElementById(`${rowId}-chevron`)
  if (!detail) return
  const isOpen = !detail.classList.contains('hidden')
  detail.classList.toggle('hidden', isOpen)
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)'
}

function auditToggleRefresh() {
  const btn = document.getElementById('audit-auto-refresh')
  if (_timer) {
    clearInterval(_timer)
    _timer = null
    if (btn) { btn.classList.remove('btn-primary'); btn.title = t('audit.btn.auto_refresh_title') }
  } else {
    _timer = setInterval(() => {
      if (!document.getElementById('audit-body')) { clearInterval(_timer); _timer = null; return }
      auditLoad()
    }, 30_000)
    if (btn) { btn.classList.add('btn-primary'); btn.title = t('audit.btn.auto_refresh_active') }
    auditLoad()
  }
}
