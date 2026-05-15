const ICONS = {
  agent_checkin:  'ti-device-laptop',
  setup_script:   'ti-script',
  intune_sync:    'ti-cloud-download',
  token_created:  'ti-key',
  token_revoked:  'ti-key-off',
  admin_granted:  'ti-shield-check',
  admin_revoked:  'ti-shield-off',
  device_deleted: 'ti-trash',
  ticket_created: 'ti-ticket',
  ticket_resolved:'ti-check',
  ssh_session:    'ti-terminal-2',
  script_run:     'ti-player-play',
}

// Ligne principale lisible selon l'action
function rowTitle(r) {
  const d = r.details || {}
  switch (r.action) {
    case 'agent_checkin':
      return r.target || d.hostname || r.action
    case 'intune_sync': {
      const base = t('mobile.audit.intune_summary', { n: d.upserted ?? 0 })
      return d.errors ? `${base} · ${t('mobile.audit.intune_errors', { n: d.errors })}` : base
    }
    case 'setup_script':
      return r.target ? `${r.target}` : r.action
    case 'token_created':
    case 'token_revoked':
      return r.target || r.action
    case 'admin_granted':
    case 'admin_revoked':
      return r.target || r.by_user || r.action
    case 'device_deleted':
      return r.target || r.action
    default:
      return r.target || r.by_user || r.action
  }
}

// Sous-titre (infos secondaires)
function rowSub(r) {
  const d = r.details || {}
  const parts = []
  if (r.by_user && r.by_user !== rowTitle(r)) parts.push(r.by_user)
  switch (r.action) {
    case 'agent_checkin':
      if (d.ip_netbird)   parts.push(d.ip_netbird)
      if (d.disks != null) parts.push(d.disks > 1
        ? t('mobile.audit.disks_many', { n: d.disks })
        : t('mobile.audit.disks_one',  { n: d.disks }))
      if (d.new)           parts.push(t('mobile.audit.new_marker'))
      break
    case 'setup_script':
      if (d.level) parts.push(d.level)
      break
    case 'intune_sync':
      break
  }
  return parts.join(' · ')
}

// Formatter les détails en lignes lisibles
function formatDetails(r) {
  const d = r.details || {}
  const lines = []

  // Log brut en premier si dispo
  if (d.log) {
    lines.push({ label: t('mobile.audit.label_log'), value: d.log, mono: true, pre: true })
  }

  // Champs structurés
  const skip = new Set(['log'])
  for (const [k, v] of Object.entries(d)) {
    if (skip.has(k) || v == null || v === '') continue
    const label = k.replace(/_/g, ' ')
    if (typeof v === 'object') {
      lines.push({ label, value: JSON.stringify(v, null, 2), mono: true })
    } else {
      lines.push({ label, value: String(v), mono: false })
    }
  }

  return lines
}

let _rows   = []
let _total  = 0
let _offset = 0

export async function renderAudit(el) {
  _rows   = []
  _offset = 0
  _total  = 0

  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1>${t('mobile.audit.title')} <span id="m-audit-count" style="font-size:12px;font-weight:400;color:var(--text-tertiary)"></span></h1>
    </div>
    <div class="m-filters" style="padding-bottom:6px">
      <button class="m-filter-pill active" data-f="" onclick="mAuditSetFilter('',this)">${t('mobile.audit.filter.all')}</button>
      <button class="m-filter-pill" data-f="agent_checkin"  onclick="mAuditSetFilter('agent_checkin',this)">${t('mobile.audit.filter.checkin')}</button>
      <button class="m-filter-pill" data-f="intune_sync"    onclick="mAuditSetFilter('intune_sync',this)">${t('mobile.audit.filter.intune')}</button>
      <button class="m-filter-pill" data-f="setup_script"   onclick="mAuditSetFilter('setup_script',this)">${t('mobile.audit.filter.scripts')}</button>
      <button class="m-filter-pill" data-f="token_created"  onclick="mAuditSetFilter('token_created',this)">${t('mobile.audit.filter.tokens')}</button>
    </div>
    <div class="m-scroll-list" id="m-audit-list" style="gap:0;padding-top:4px">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mAuditSetFilter = (f, btn) => {
    _offset = 0
    _rows   = []
    el.querySelectorAll('.m-filter-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    loadAudit(f, false)
  }

  await loadAudit('', false)
}

async function loadAudit(action, append) {
  const list = document.getElementById('m-audit-list')
  if (!list) return
  if (!append) {
    list.innerHTML = `<div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>`
  }

  try {
    const data = await window.api.getAudit({ action: action || null, limit: 50, offset: _offset })
    _total = data.total
    const newRows = data.rows || []
    _rows = append ? [..._rows, ...newRows] : newRows
    renderRows(action, append, newRows)
  } catch (err) {
    if (!append) list.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function renderRows(action, append, newRows) {
  const list = document.getElementById('m-audit-list')
  const countEl = document.getElementById('m-audit-count')
  if (!list) return

  if (countEl) countEl.textContent = `${_rows.length}${_total > _rows.length ? '+' : ''}`

  if (!_rows.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.audit.empty')}</div>`
    return
  }

  const html = newRows.map((r, i) => {
    const icon     = ICONS[r.action] || 'ti-dots'
    const title    = rowTitle(r)
    const sub      = rowSub(r)
    const details  = formatDetails(r)
    const hasDetail = details.length > 0
    const rowId    = `mar-${_offset}-${i}`
    const d        = r.details || {}
    const levelColor = d.level === 'error' ? 'var(--red)' : d.level === 'warn' ? 'var(--amber)' : null

    return `
    <div class="m-audit-row" id="${rowId}">
      <div class="m-audit-row-main" onclick="${hasDetail ? `mAuditToggle('${rowId}')` : ''}">
        <div class="m-audit-icon">
          <i class="ti ${icon}" style="font-size:14px;color:${levelColor || 'var(--text-secondary)'}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.3px">${esc(r.action)}</span>
            ${levelColor ? `<span style="font-size:10px;font-weight:700;color:${levelColor}">${esc(d.level?.toUpperCase() || '')}</span>` : ''}
          </div>
          <div style="font-size:13px;font-weight:600;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:1px">${esc(sub)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">
          <span style="font-size:10px;color:var(--text-tertiary)">${formatRelative(r.created_at)}</span>
          ${hasDetail ? `<i class="ti ti-chevron-right m-audit-chevron" id="${rowId}-chv"></i>` : ''}
        </div>
      </div>
      ${hasDetail ? `
      <div class="m-audit-detail" id="${rowId}-detail" style="display:none">
        ${details.map(line => line.pre
          ? `<div class="m-audit-log-block"><pre>${esc(line.value)}</pre></div>`
          : `<div class="m-audit-detail-row">
               <span class="m-audit-detail-key">${esc(line.label)}</span>
               <span class="m-audit-detail-val ${line.mono ? 'm-mono' : ''}">${esc(line.value)}</span>
             </div>`
        ).join('')}
      </div>` : ''}
    </div>`
  }).join('')

  if (append) {
    // Retirer le bouton "Charger plus" s'il existe, puis réinsérer
    const btn = list.querySelector('.m-load-more-btn')
    if (btn) btn.remove()
    list.insertAdjacentHTML('beforeend', html)
  } else {
    list.innerHTML = html
  }

  // Bouton "charger plus"
  if (_rows.length < _total) {
    const currentAction = [...document.querySelectorAll('.m-filter-pill.active')][0]?.dataset?.f || ''
    list.insertAdjacentHTML('beforeend', `
      <button class="m-load-more-btn" style="width:100%;padding:12px;margin-top:4px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;color:var(--text-secondary);cursor:pointer"
        onclick="mAuditLoadMore('${currentAction}')">
        ${t('mobile.audit.load_more', { n: _total - _rows.length })}
      </button>`)
    window.mAuditLoadMore = async (a) => {
      _offset += 50
      await loadAudit(a, true)
    }
  }

  window.mAuditToggle = (rowId) => {
    const detail  = document.getElementById(`${rowId}-detail`)
    const chevron = document.getElementById(`${rowId}-chv`)
    if (!detail) return
    const open = detail.style.display !== 'none'
    detail.style.display = open ? 'none' : 'block'
    if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)'
  }
}
