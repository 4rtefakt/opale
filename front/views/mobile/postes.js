let _devices = []
let _filter  = 'all'
let _selectMode = false
let _selected = new Set()

export async function renderPostes(el) {
  _filter = 'all'
  _selectMode = false
  _selected = new Set()

  el.innerHTML = `
    <div class="m-header">
      <h1>${t('mobile.postes.title')} <span id="m-postes-count" style="font-size:12px;font-weight:400;color:var(--text-tertiary)"></span></h1>
    </div>
    <div class="m-search">
      <i class="ti ti-search"></i>
      <input type="text" placeholder="${t('mobile.postes.search_placeholder')}" id="m-postes-q" oninput="mPostesFilter()">
    </div>
    <div class="m-filters">
      <button class="m-filter-pill active" data-f="all" onclick="mPostesSetFilter('all',this)">${t('mobile.postes.filter.all')}</button>
      <button class="m-filter-pill" data-f="online"   onclick="mPostesSetFilter('online',this)">${t('mobile.postes.filter.online')}</button>
      <button class="m-filter-pill" data-f="offline"  onclick="mPostesSetFilter('offline',this)">${t('mobile.postes.filter.offline')}</button>
      <button class="m-filter-pill" data-f="critical" onclick="mPostesSetFilter('critical',this)">${t('mobile.postes.filter.critical')}</button>
    </div>
    <div class="m-scroll-list" id="m-postes-list" style="padding-bottom:84px">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>

    <!-- Action bar (apparaît en mode sélection) -->
    <div id="m-postes-actionbar" style="
      position:fixed;left:0;right:0;bottom:56px;
      background:var(--bg-secondary);border-top:1px solid var(--border);
      padding:10px 12px;display:none;flex-direction:column;gap:8px;
      box-shadow:0 -4px 12px rgba(0,0,0,.25);z-index:50;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span id="m-postes-actionbar-count" style="font-size:13px;font-weight:600">0 ${t('mobile.postes.bulk.selected')}</span>
        <button class="m-icon-btn" onclick="mPostesExitSelect()" title="${t('mobile.postes.bulk.exit')}">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        <button class="m-action-btn blue" onclick="mPostesBulkCheckin()">
          <i class="ti ti-refresh"></i>
          <span style="font-size:11px;margin-top:2px">${t('mobile.postes.bulk.checkin')}</span>
        </button>
        <button class="m-action-btn blue" onclick="mPostesBulkSyncIntune()">
          <i class="ti ti-brand-azure"></i>
          <span style="font-size:11px;margin-top:2px">${t('mobile.postes.bulk.sync_intune')}</span>
        </button>
        <button class="m-action-btn green" onclick="mPostesBulkRunScript()">
          <i class="ti ti-player-play"></i>
          <span style="font-size:11px;margin-top:2px">${t('mobile.postes.bulk.run_script')}</span>
        </button>
      </div>
    </div>`

  window.mPostesFilter    = () => renderList()
  window.mPostesSetFilter = (f, btn) => {
    _filter = f
    el.querySelectorAll('.m-filter-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    renderList()
  }
  window.mPostesExitSelect    = exitSelectMode
  window.mPostesBulkCheckin   = bulkCheckin
  window.mPostesBulkSyncIntune = bulkSyncIntune
  window.mPostesBulkRunScript = bulkRunScript

  try {
    const data = await window.api.getDevices({ limit: 200 })
    _devices   = data.devices || []
    updatePillCounts()
    renderList()
  } catch (err) {
    document.getElementById('m-postes-list').innerHTML =
      `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function updatePillCounts() {
  const nOnline   = _devices.filter(d => d.status === 'online').length
  const nOffline  = _devices.filter(d => d.status === 'offline').length
  const nCritical = _devices.filter(d => d.status === 'critical' || d.status === 'warn').length
  const map = {
    all:      t('mobile.postes.filter.all_count',      { n: _devices.length }),
    online:   t('mobile.postes.filter.online_count',   { n: nOnline }),
    offline:  t('mobile.postes.filter.offline_count',  { n: nOffline }),
    critical: t('mobile.postes.filter.critical_count', { n: nCritical }),
  }
  Object.entries(map).forEach(([f, txt]) => {
    const pill = document.querySelector(`.m-filter-pill[data-f="${f}"]`)
    if (pill) pill.textContent = txt
  })
}

function renderList() {
  const q       = (document.getElementById('m-postes-q')?.value || '').toLowerCase()
  const filtered = _devices.filter(d => {
    const matchQ = !q || d.hostname.toLowerCase().includes(q)
      || d.user?.name?.toLowerCase().includes(q)
      || d.model?.toLowerCase().includes(q)
      || d.serial?.toLowerCase().includes(q)
      || d.ip_netbird?.toLowerCase().includes(q)
    const matchF = _filter === 'all'
      || (_filter === 'online'   && d.status === 'online')
      || (_filter === 'offline'  && d.status === 'offline')
      || (_filter === 'critical' && (d.status === 'critical' || d.status === 'warn'))
    return matchQ && matchF
  }).sort((a, b) => {
    const o = { critical:0, warn:1, online:2, offline:3 }
    return (o[a.status] ?? 4) - (o[b.status] ?? 4) || a.hostname.localeCompare(b.hostname)
  })

  const countEl = document.getElementById('m-postes-count')
  if (countEl) countEl.textContent = `${filtered.length}`

  const list = document.getElementById('m-postes-list')
  if (!list) return

  if (!filtered.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.postes.empty')}</div>`
    return
  }

  list.innerHTML = filtered.map(d => {
    const pct      = parseFloat(d.disk_used_pct) || 0
    const barColor = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)'
    const dotColor = d.status === 'online' ? 'var(--green)' : d.status === 'critical' ? 'var(--red)' : d.status === 'warn' ? 'var(--amber)' : 'var(--text-tertiary)'
    const pillCls  = d.status === 'online' ? 'on' : d.status === 'critical' ? 'crit' : d.status === 'warn' ? 'warn' : 'off'
    const pillKey  = d.status === 'online' ? 'mobile.postes.status.online'
                   : d.status === 'critical' ? 'mobile.postes.status.critical'
                   : d.status === 'warn' ? 'mobile.postes.status.warn'
                   : 'mobile.postes.status.offline'
    const isSelected = _selected.has(d.id)
    const selectedStyle = isSelected
      ? 'border:1.5px solid var(--blue);background:rgba(59,130,246,.08)'
      : ''
    return `
      <div class="m-device-card" data-id="${esc(d.id)}" style="position:relative;${selectedStyle}">
        ${isSelected ? `<i class="ti ti-circle-check-filled" style="position:absolute;top:6px;right:6px;color:var(--blue);font-size:18px;background:var(--bg-secondary);border-radius:50%"></i>` : ''}
        <div class="m-status-dot" style="background:${dotColor}"></div>
        <div class="m-device-info">
          <div class="m-device-name">${esc(d.hostname)}</div>
          <div class="m-device-sub">${esc(d.model || d.manufacturer || '—')}${d.user?.name ? ' · ' + esc(d.user.name) : ''}</div>
          ${d.ip_netbird ? `<div class="m-device-ip">${esc(d.ip_netbird)}</div>` : ''}
        </div>
        <div class="m-device-right">
          <span class="m-pill m-pill-${pillCls}">${t(pillKey)}</span>
          ${pct > 0 ? `<div class="m-disk-mini"><div class="m-disk-mini-fill" style="width:${pct}%;background:${barColor}"></div></div>` : ''}
          <span style="font-size:10px;color:var(--text-tertiary)">${formatRelative(d.last_seen)}</span>
        </div>
      </div>`
  }).join('')

  // Attacher click + long-press handlers
  list.querySelectorAll('.m-device-card[data-id]').forEach(card => {
    const id = card.dataset.id
    attachCardHandlers(card, id)
  })
}

// ─── Multi-select : click + long-press ───
function attachCardHandlers(card, id) {
  // Click : navigation OU toggle selection selon mode
  card.addEventListener('click', (e) => {
    // Si un long-press vient d'être déclenché, le timer a déjà tout fait : on ignore le click qui suit
    if (card._longPressFired) { card._longPressFired = false; e.preventDefault(); e.stopPropagation(); return }
    if (_selectMode) {
      toggleSelect(id)
    } else {
      window.location.hash = '#/poste/' + id
    }
  })

  // Long-press : entrée en mode select (500ms tap stationnaire)
  let timer = null
  let startX = 0, startY = 0
  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    card._longPressFired = false
    timer = setTimeout(() => {
      timer = null
      card._longPressFired = true
      // Vibration légère si disponible (feedback tactile)
      if (navigator.vibrate) try { navigator.vibrate(20) } catch {}
      enterSelectMode(id)
    }, 500)
  }, { passive: true })
  const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  card.addEventListener('touchmove', (e) => {
    if (!timer) return
    const dx = Math.abs(e.touches[0].clientX - startX)
    const dy = Math.abs(e.touches[0].clientY - startY)
    if (dx > 10 || dy > 10) cancelTimer()
  }, { passive: true })
  card.addEventListener('touchend',    cancelTimer)
  card.addEventListener('touchcancel', cancelTimer)
}

function enterSelectMode(id) {
  _selectMode = true
  _selected.add(id)
  renderList()
  updateActionBar()
}

function toggleSelect(id) {
  if (_selected.has(id)) _selected.delete(id)
  else _selected.add(id)
  if (_selected.size === 0) {
    exitSelectMode()
  } else {
    renderList()
    updateActionBar()
  }
}

function exitSelectMode() {
  _selectMode = false
  _selected.clear()
  renderList()
  updateActionBar()
}

function updateActionBar() {
  const bar = document.getElementById('m-postes-actionbar')
  if (!bar) return
  if (_selected.size === 0) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'
  const cnt = document.getElementById('m-postes-actionbar-count')
  if (cnt) {
    const n = _selected.size
    cnt.textContent = n + ' ' + (n > 1
      ? t('mobile.postes.bulk.selected_plural')
      : t('mobile.postes.bulk.selected'))
  }
}

// ─── Bulk actions ───

async function bulkCheckin() {
  const ids = [..._selected]
  if (!ids.length) return
  try {
    const res = await window.api.forceCheckinDevices(ids)
    showToast(formatBulkResult(res, 'checkin'), res.errors?.length ? 'error' : 'success')
  } catch (err) {
    showToast(err.message || t('mobile.postes.bulk.toast.error'), 'error')
  }
  exitSelectMode()
}

async function bulkSyncIntune() {
  const ids = [..._selected]
  if (!ids.length) return
  try {
    const res = await window.api.forceSyncDevices(ids)
    showToast(formatBulkResult(res, 'sync'), res.errors?.length ? 'error' : 'success')
  } catch (err) {
    showToast(err.message || t('mobile.postes.bulk.toast.error'), 'error')
  }
  exitSelectMode()
}

function formatBulkResult(res, kind) {
  const parts = []
  if (res.ok > 0)         parts.push(res.ok + ' ' + t('mobile.postes.bulk.toast.' + kind + '_ok'))
  if (res.skipped > 0)    parts.push(res.skipped + ' ' + t('mobile.postes.bulk.toast.skipped'))
  if (res.errors?.length) parts.push(res.errors.length + ' ' + t('mobile.postes.bulk.toast.errors'))
  return parts.join(' · ') || t('mobile.postes.bulk.toast.error')
}

async function bulkRunScript() {
  const count = _selected.size
  if (!count) return

  let scripts = []
  try {
    scripts = await window.api.getScripts()
  } catch {
    showToast(t('mobile.postes.bulk.scripts.load_error'), 'error')
    return
  }

  if (!scripts.length) {
    showToast(t('mobile.postes.bulk.scripts.empty'), 'error')
    return
  }

  const ids = [..._selected]
  const options = scripts.map(s =>
    `<option value="${esc(s.id)}">${esc(s.name)}</option>`
  ).join('')

  window.mShowSheet(`
    <div class="m-sheet-title">
      <i class="ti ti-player-play" style="color:var(--green)"></i>
      ${t('mobile.postes.bulk.scripts.sheet_title')}
    </div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:14px">
      <div style="font-size:13px;color:var(--text-secondary)">
        ${t('mobile.postes.bulk.scripts.target', { n: count })}
      </div>
      <div>
        <div class="m-label">${t('mobile.postes.bulk.scripts.choose')}</div>
        <select class="m-input" id="m-postes-script-select">${options}</select>
      </div>
      <div style="font-size:12px;color:var(--amber);display:flex;align-items:center;gap:6px">
        <i class="ti ti-clock"></i> ${t('mobile.postes.bulk.scripts.delay')}
      </div>
      <button class="m-btn-primary" id="m-postes-script-confirm">
        <i class="ti ti-player-play"></i> ${t('mobile.postes.bulk.scripts.confirm')}
      </button>
    </div>`)

  document.getElementById('m-postes-script-confirm')?.addEventListener('click', async () => {
    const scriptId = document.getElementById('m-postes-script-select')?.value
    if (!scriptId) return
    window.mCloseSheet()

    let ok = 0, fail = 0
    await Promise.all(ids.map(async deviceId => {
      try {
        await window.api.runScript(scriptId, deviceId)
        ok++
      } catch {
        fail++
      }
    }))

    if (fail === 0) {
      showToast(t('mobile.postes.bulk.scripts.toast_ok', { n: ok }), 'success')
    } else {
      showToast(ok + ' OK · ' + fail + ' ' + t('mobile.postes.bulk.toast.errors'),
        fail === ids.length ? 'error' : 'info')
    }

    exitSelectMode()
  })
}
