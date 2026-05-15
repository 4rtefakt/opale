let _devices = []
let _filter  = 'all'
let _sortBy  = localStorage.getItem('postes-sort') || 'status'
let _selected = new Set()
// Seuils disque tirés des settings serveur (override après loadDevices via
// data.thresholds). Defaults alignés avec ceux de l'API si le call échoue.
let _thresholds = { warn: 80, critical: 90 }

// Filtres valides — mêmes valeurs que les boutons UI. Utilisé pour le
// deep-link via `#/postes?status=...` depuis le dashboard.
const _VALID_FILTERS = new Set(['all', 'online', 'offline', 'critical', 'unassigned'])

// Fenêtre "vivant" : aligné avec computeStatus côté API (offline si
// ageMs > 1h). Les filtres UI sont orthogonaux :
//   - "En ligne"  : a checkin récemment, peu importe le disque
//   - "Hors ligne": pas vu depuis ≥ 1h
//   - "Critique"  : disque ≥ disk_critical_pct, peu importe online/offline
// On ne peut PAS s'appuyer sur `d.status` (exclusif côté serveur) pour ces
// filtres : un poste critique-offline serait absent de "Critique" et un
// poste critique-online absent de "En ligne".
const _ONLINE_WINDOW_MS = 60 * 60 * 1000
const _isOnline = d => !!d.last_seen && (Date.now() - new Date(d.last_seen).getTime()) <= _ONLINE_WINDOW_MS
const _isCritical = d => (parseFloat(d.disk_used_pct) || 0) >= _thresholds.critical

function parseStatusFromHash() {
  const q = (window.location.hash || '').split('?')[1]
  if (!q) return null
  const status = new URLSearchParams(q).get('status')
  return _VALID_FILTERS.has(status) ? status : null
}

export async function renderPostes(container) {
  // Filtre initial = `?status=` du hash si valide, sinon 'all'. Permet de
  // drill-down depuis le dashboard (clic sur KPI "Disques critiques" →
  // `#/postes?status=critical`).
  _filter   = parseStatusFromHash() || 'all'
  _selected = new Set()

  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <span class="page-title">${t('nav.postes')}</span>
        <span id="postes-count" style="font-size:12px;color:var(--text-tertiary)">—</span>
      </div>
      <div class="topbar-right">
        <button class="btn" onclick="exportCSV()"><i class="ti ti-download"></i> Exporter CSV</button>
        <button class="btn" id="btn-sync-inv" onclick="syncIntune()" title="Importer les postes depuis Intune MDM"><i class="ti ti-refresh"></i> Sync Intune</button>
        <button class="btn btn-primary" onclick="navigateTo('/onboarding')"><i class="ti ti-plus"></i> Ajouter</button>
      </div>
    </div>

    <!-- BULK BAR -->
    <div class="bulk-bar" id="bulk-bar">
      <i class="ti ti-checkbox" style="font-size:16px;color:var(--blue-text)"></i>
      <span class="bulk-count" id="bulk-count">0 postes sélectionnés</span>
      <div class="bulk-actions">
        <button class="btn"><i class="ti ti-terminal-2"></i> SSH groupé</button>
        <button class="btn" onclick="bulkRunScript()"><i class="ti ti-player-play"></i> Lancer script</button>
        <button class="btn" onclick="bulkForceCheckin()"><i class="ti ti-refresh"></i> Forcer sync</button>
        <button class="btn" onclick="bulkForceSync()"><i class="ti ti-brand-azure"></i> Sync Intune</button>
        <button class="btn btn-danger" onclick="clearSelection()"><i class="ti ti-x"></i> Désélectionner</button>
      </div>
    </div>

    <!-- TOOLBAR -->
    <div class="toolbar">
      <div class="search-bar">
        <i class="ti ti-search"></i>
        <input type="text" placeholder="${t('postes.search')}" id="postes-search" oninput="postesFilter()">
      </div>
      <div class="filter-group" id="filter-group">
        <button class="filter-btn ${_filter==='all'       ?'active':''}" data-filter="all"        onclick="postesSetFilter('all',this)">Tous <span id="count-all">—</span></button>
        <button class="filter-btn ${_filter==='online'    ?'active':''}" data-filter="online"     onclick="postesSetFilter('online',this)">En ligne <span id="count-online">—</span></button>
        <button class="filter-btn ${_filter==='offline'   ?'active':''}" data-filter="offline"    onclick="postesSetFilter('offline',this)">Hors ligne <span id="count-offline">—</span></button>
        <button class="filter-btn ${_filter==='critical'  ?'active':''}" data-filter="critical"   onclick="postesSetFilter('critical',this)">⚠ Critique <span id="count-critical">—</span></button>
        <button class="filter-btn ${_filter==='unassigned'?'active':''}" data-filter="unassigned" onclick="postesSetFilter('unassigned',this)">Non assignés <span id="count-unassigned">—</span></button>
      </div>
      <div class="toolbar-right">
        <select class="sort-select" onchange="postesSort(this.value)">
          <option value="name"   ${_sortBy==='name'   ?'selected':''}>Trier : Nom</option>
          <option value="disk"   ${_sortBy==='disk'   ?'selected':''}>Trier : Disque</option>
          <option value="user"   ${_sortBy==='user'   ?'selected':''}>Trier : Utilisateur</option>
          <option value="last"   ${_sortBy==='last'   ?'selected':''}>Trier : Dernière activité</option>
          <option value="status" ${_sortBy==='status' ?'selected':''}>Trier : Statut</option>
        </select>
      </div>
    </div>

    <!-- SUMMARY -->
    <div class="summary-bar" id="summary-bar">
      <div class="summary-item"><div class="summary-dot" style="background:var(--green)"></div><span class="summary-count" id="s-online">—</span> en ligne</div>
      <div class="summary-item"><div class="summary-dot" style="background:var(--gray)"></div><span class="summary-count" id="s-offline">—</span> hors ligne</div>
      <div class="summary-item"><div class="summary-dot" style="background:var(--red)"></div><span class="summary-count" id="s-critical">—</span> disque critique <span id="s-critical-thr" style="color:var(--text-tertiary)"></span></div>
      <div class="summary-item" style="margin-left:auto;font-size:11px;color:var(--text-tertiary)" id="s-sync"></div>
    </div>

    <!-- TABLE -->
    <div class="table-wrap">
      <table id="postes-table">
        <thead>
          <tr>
            <th class="td-check"><input type="checkbox" id="check-all" onchange="postesToggleAll(this)"></th>
            <th onclick="postesSort('name')">Nom <i class="ti ti-selector sort-icon"></i></th>
            <th onclick="postesSort('user')">Utilisateur <i class="ti ti-selector sort-icon"></i></th>
            <th>Modèle</th>
            <th>OS</th>
            <th>Agent</th>
            <th onclick="postesSort('disk')">Disque C: <i class="ti ti-selector sort-icon"></i></th>
            <th>RAM</th>
            <th onclick="postesSort('last')">Dernier push <i class="ti ti-selector sort-icon"></i></th>
            <th onclick="postesSort('status')">Statut <i class="ti ti-selector sort-icon"></i></th>
            <th style="width:80px"></th>
          </tr>
        </thead>
        <tbody id="postes-tbody"><tr><td colspan="11" style="text-align:center;padding:2rem;color:var(--text-tertiary)"><div class="loading-spinner" style="margin:0 auto"></div></td></tr></tbody>
      </table>
    </div>

    <!-- PAGINATION -->
    <div class="pagination">
      <span id="paginfo" style="color:var(--text-tertiary)">Chargement…</span>
      <div class="page-btns" id="page-btns"></div>
    </div>`

  // Exposer les handlers globalement pour les handlers inline
  window.postesFilter       = postesFilter
  window.postesSetFilter    = postesSetFilter
  window.postesSort         = postesSort
  window.postesToggleAll    = postesToggleAll
  window.postesToggleRow    = postesToggleRow
  window.clearSelection     = clearSelection
  window.exportCSV          = exportCSV
  window.syncIntune         = syncIntune
  window.bulkRunScript        = bulkRunScript
  window.bulkRunScriptConfirm = bulkRunScriptConfirm
  window.bulkForceSync        = bulkForceSync
  window.bulkForceCheckin     = bulkForceCheckin

  await loadDevices()
}

async function loadDevices() {
  try {
    const data = await window.api.getDevices({ limit: 200 })
    _devices = data.devices
    if (data.thresholds) _thresholds = data.thresholds
    updateSummary()
    renderTable()
  } catch (err) {
    document.getElementById('postes-tbody').innerHTML =
      `<tr><td colspan="11" style="padding:1rem;color:var(--red)">${esc(err.message)}</td></tr>`
  }
}

function updateSummary() {
  // Filtres orthogonaux (cf. helpers en tête de fichier) — un poste peut
  // être à la fois "En ligne" et "Critique".
  const online   = _devices.filter(_isOnline).length
  const offline  = _devices.filter(d => !_isOnline(d)).length
  const critical = _devices.filter(_isCritical).length

  const thrLabel = document.getElementById('s-critical-thr')
  if (thrLabel) thrLabel.textContent = `(≥${_thresholds.critical}%)`

  document.getElementById('s-online')  && (document.getElementById('s-online').textContent  = online)
  document.getElementById('s-offline') && (document.getElementById('s-offline').textContent = offline)
  document.getElementById('s-critical')&& (document.getElementById('s-critical').textContent = critical)

  document.getElementById('count-all')       && (document.getElementById('count-all').textContent = _devices.length)
  document.getElementById('count-online')    && (document.getElementById('count-online').textContent = online)
  document.getElementById('count-offline')   && (document.getElementById('count-offline').textContent = offline)
  document.getElementById('count-critical')  && (document.getElementById('count-critical').textContent = critical)
  document.getElementById('count-unassigned')&& (document.getElementById('count-unassigned').textContent = _devices.filter(d => !d.user).length)

  document.getElementById('postes-count') &&
    (document.getElementById('postes-count').textContent = `${_devices.length} appareils`)

  const lastSeen = _devices.map(d => d.last_seen).filter(Boolean).sort().pop()
  if (lastSeen && document.getElementById('s-sync')) {
    document.getElementById('s-sync').textContent = `Dernier sync ${formatRelative(lastSeen)}`
  }
}

function getFiltered() {
  const q = (document.getElementById('postes-search')?.value || '').toLowerCase()
  return _devices.filter(d => {
    const matchSearch = !q
      || d.hostname.toLowerCase().includes(q)
      || (d.user?.name?.toLowerCase().includes(q))
      || (d.user?.email?.toLowerCase().includes(q))
      || (d.model?.toLowerCase().includes(q))
      || (d.serial?.toLowerCase().includes(q))
      || (d.ip_netbird?.toLowerCase().includes(q))

    const matchFilter = _filter === 'all'
      || (_filter === 'online'     &&  _isOnline(d))
      || (_filter === 'offline'    && !_isOnline(d))
      || (_filter === 'critical'   &&  _isCritical(d))
      || (_filter === 'unassigned' && !d.user)

    return matchSearch && matchFilter
  })
}

function renderTable() {
  const tbody = document.getElementById('postes-tbody')
  if (!tbody) return

  const devices = sortDevices(getFiltered())
  document.getElementById('paginfo').textContent =
    `Affichage 1–${devices.length} sur ${devices.length}`

  if (devices.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state" style="padding:2rem"><i class="ti ti-device-laptop"></i><p>Aucun poste trouvé</p></div></td></tr>`
    return
  }

  tbody.innerHTML = devices.map(d => deviceRow(d)).join('')
}

function sortDevices(list) {
  return [...list].sort((a, b) => {
    if (_sortBy === 'name')   return a.hostname.localeCompare(b.hostname)
    if (_sortBy === 'disk')   return (parseFloat(b.disk_used_pct) || 0) - (parseFloat(a.disk_used_pct) || 0)
    if (_sortBy === 'user')   return (a.user?.name || 'zzz').localeCompare(b.user?.name || 'zzz')
    if (_sortBy === 'last')   return (new Date(b.last_seen || 0)) - (new Date(a.last_seen || 0))
    if (_sortBy === 'status') {
      // Tri Statut : tout ce qui est "vivant" (a checkin récemment) en tête,
      // puis les hors-ligne triés par criticité disque. Les filtres "online"
      // et "critique" étant orthogonaux, on s'appuie sur _isOnline (last_seen)
      // plutôt que sur le `d.status` exclusif côté serveur.
      const rank = d => {
        if (_isOnline(d)) return 0
        const pct = parseFloat(d.disk_used_pct) || 0
        if (pct >= _thresholds.critical) return 11
        if (pct >= _thresholds.warn)     return 12
        if (!d.user)                     return 13
        return 14
      }
      return rank(a) - rank(b)
    }
    return 0
  })
}

function deviceRow(d) {
  const pct    = parseFloat(d.disk_used_pct) || 0
  const fill   = pct >= _thresholds.critical ? 'fill-danger' : pct >= _thresholds.warn ? 'fill-warn' : 'fill-ok'
  const pctCls = pct >= _thresholds.critical ? 'style="color:var(--red)"' : pct >= _thresholds.warn ? 'style="color:var(--amber)"' : ''
  const sel    = _selected.has(d.id) ? 'selected' : ''

  const ram = d.ram_gb ? `${parseFloat(d.ram_gb).toFixed(0)} Go` : '—'

  return `
    <tr class="${sel}" onclick="postesRowClick(event,'${d.id}')" data-id="${esc(d.id)}">
      <td class="td-check"><input type="checkbox" class="row-check" data-id="${esc(d.id)}"
        ${_selected.has(d.id) ? 'checked' : ''}
        onclick="event.stopPropagation();postesToggleRow(this,'${esc(d.id)}')"></td>
      <td>
        <div class="hostname"><a href="#/postes/${esc(d.id)}" class="nav-link" onclick="event.stopPropagation()">${esc(d.hostname)}</a></div>
        <div class="hostname-sub">${esc(d.model || '—')}</div>
        ${d.ip_netbird ? `<div class="hostname-sub" style="color:var(--text-tertiary);font-family:monospace">${esc(d.ip_netbird)}</div>` : ''}
      </td>
      <td>
        ${d.user
          ? `<div class="user-cell">
               <div class="user-av">${initials(d.user.name)}</div>
               <div>
                 <div class="user-name"><a href="#/users/${esc(d.user.email)}" class="nav-link" onclick="event.stopPropagation()">${esc(d.user.name)}</a></div>
                 <div class="user-email">${esc(d.user.email)}</div>
               </div>
             </div>`
          : `<span style="color:var(--text-tertiary);font-size:11px">Non assigné</span>`
        }
      </td>
      <td style="color:var(--text-secondary);white-space:nowrap">${esc(d.model || '—')}</td>
      <td><span class="os-badge"><i class="ti ti-brand-windows"></i>${esc(d.os || '—')}</span></td>
      <td style="color:var(--text-tertiary);font-size:11px;font-family:monospace;white-space:nowrap">${d.agent_version ? 'v' + esc(d.agent_version) : '—'}</td>
      <td>
        <div class="disk-wrap">
          <div class="disk-bar"><div class="disk-fill ${fill}" style="width:${pct}%"></div></div>
          <span class="disk-pct" ${pctCls}>${pct}%</span>
        </div>
      </td>
      <td><span class="ram-cell">${ram}</span></td>
      <td style="color:var(--text-tertiary);font-size:11px">${formatRelative(d.last_seen)}</td>
      <td>${statusPill(d)}</td>
      <td style="text-align:right">
        <a href="#/postes/${esc(d.id)}" class="action-btn" onclick="event.stopPropagation()"><i class="ti ti-arrow-right"></i></a>
      </td>
    </tr>`
}

function statusPill(d) {
  const connPill = _isOnline(d)
    ? `<span class="status-pill pill-on"><span class="pill-dot"></span>En ligne</span>`
    : `<span class="status-pill pill-off"><span class="pill-dot"></span>Hors ligne</span>`

  const pct = parseFloat(d.disk_used_pct) || 0
  let healthPill = ''
  if (pct >= _thresholds.critical)     healthPill = `<span class="status-pill pill-crit"><span class="pill-dot"></span>Critique</span>`
  else if (pct >= _thresholds.warn)    healthPill = `<span class="status-pill pill-warn"><span class="pill-dot"></span>Alerte</span>`
  else if (!d.user)    healthPill = `<span class="status-pill pill-off"><span class="pill-dot"></span>Non assigné</span>`

  return healthPill
    ? `<div style="display:flex;flex-direction:column;gap:3px">${connPill}${healthPill}</div>`
    : connPill
}

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

// ─── Handlers ───
function postesFilter()  { renderTable() }

function postesSetFilter(f, btn) {
  _filter = f
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  renderTable()
}

function postesSort(by) {
  _sortBy = by
  localStorage.setItem('postes-sort', by)
  renderTable()
}

function postesToggleAll(cb) {
  const rows = document.querySelectorAll('.row-check')
  rows.forEach(r => {
    r.checked = cb.checked
    const id = r.dataset.id
    cb.checked ? _selected.add(id) : _selected.delete(id)
  })
  updateBulkBar()
  // Mettre à jour les classes .selected
  document.querySelectorAll('#postes-tbody tr[data-id]').forEach(tr => {
    tr.classList.toggle('selected', _selected.has(tr.dataset.id))
  })
}

function postesToggleRow(cb, id) {
  cb.checked ? _selected.add(id) : _selected.delete(id)
  const tr = cb.closest('tr')
  if (tr) tr.classList.toggle('selected', cb.checked)
  updateBulkBar()
}

window.postesRowClick = function(e, id) {
  if (e.target.type === 'checkbox' || e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return
  _selected.has(id) ? _selected.delete(id) : _selected.add(id)
  const tr = document.querySelector(`tr[data-id="${id}"]`)
  if (tr) {
    tr.classList.toggle('selected', _selected.has(id))
    const cb = tr.querySelector('.row-check')
    if (cb) cb.checked = _selected.has(id)
  }
  updateBulkBar()
}

function clearSelection() {
  _selected.clear()
  document.querySelectorAll('.row-check').forEach(cb => { cb.checked = false })
  document.querySelectorAll('#postes-tbody tr').forEach(tr => tr.classList.remove('selected'))
  document.getElementById('check-all').checked = false
  updateBulkBar()
}

function updateBulkBar() {
  const n   = _selected.size
  const bar = document.getElementById('bulk-bar')
  if (bar) bar.className = 'bulk-bar' + (n > 0 ? ' show' : '')
  const cnt = document.getElementById('bulk-count')
  if (cnt) cnt.textContent = `${n} poste${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`
}

function exportCSV() {
  const devices = sortDevices(getFiltered())
  const header = ['Nom', 'Modèle', 'Fabricant', 'OS', 'RAM (Go)', 'Disque C: (%)', 'Utilisateur', 'Email', 'IP Netbird', 'Statut', 'Dernier push']
  const rows = devices.map(d => [
    d.hostname,
    d.model        || '',
    d.manufacturer || '',
    d.os           || '',
    d.ram_gb       || '',
    d.disk_used_pct != null ? d.disk_used_pct : '',
    d.user?.name   || '',
    d.user?.email  || '',
    d.ip_netbird   || '',
    d.status       || '',
    d.last_seen    || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))

  const csv  = [header.join(','), ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `postes-${new Date().toISOString().slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

async function syncIntune() {
  const btn = document.getElementById('btn-sync-inv')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Sync…' }
  try {
    const res = await window.api.syncIntune()
    showToast(`Sync terminée — ${res.upserted} postes mis à jour${res.errors ? `, ${res.errors} erreurs` : ''}`, 'success')
    await loadDevices()
  } catch (err) {
    showToast(err.message || 'Erreur lors de la sync', 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> Sync Intune' }
  }
}

// Verrou anti-double-click : un click pendant qu'une action est en cours
// (ssh, deploy, etc.) est ignoré avec un toast info. Empêche les doubles
// audit_logs et les SSH multiples sur les mêmes PCs.
const _actionLocks = new Set()
function withActionLock(key, fn) {
  if (_actionLocks.has(key)) {
    showToast('Action déjà en cours…', 'info')
    return Promise.resolve()
  }
  _actionLocks.add(key)
  return Promise.resolve(fn()).finally(() => _actionLocks.delete(key))
}

async function bulkForceCheckin() {
  const ids = [..._selected]
  if (ids.length === 0) return
  await withActionLock('bulkForceCheckin', async () => {
    try {
      const res = await window.api.forceCheckinDevices(ids)
      const parts = []
      if (res.ok > 0)      parts.push(`${res.ok} checkin déclenché${res.ok > 1 ? 's' : ''}`)
      if (res.skipped > 0) parts.push(`${res.skipped} sans IP Netbird ignoré${res.skipped > 1 ? 's' : ''}`)
      if (res.errors?.length) parts.push(`${res.errors.length} erreur${res.errors.length > 1 ? 's' : ''}`)
      showToast(parts.join(', '), res.errors?.length ? 'error' : 'success')
    } catch (err) {
      showToast(err.message || 'Erreur checkin', 'error')
    }
  })
}

async function bulkForceSync() {
  const ids = [..._selected]
  if (ids.length === 0) return
  await withActionLock('bulkForceSync', async () => {
    try {
      const res = await window.api.forceSyncDevices(ids)
      const parts = []
      if (res.ok > 0)      parts.push(`${res.ok} sync Intune envoyée${res.ok > 1 ? 's' : ''}`)
      if (res.skipped > 0) parts.push(`${res.skipped} sans Intune ignoré${res.skipped > 1 ? 's' : ''}`)
      if (res.errors?.length) parts.push(`${res.errors.length} erreur${res.errors.length > 1 ? 's' : ''}`)
      showToast(parts.join(', '), res.errors?.length ? 'error' : 'success')
    } catch (err) {
      showToast(err.message || 'Erreur sync', 'error')
    }
  })
}

async function bulkRunScript() {
  const count = _selected.size
  if (count === 0) return

  let scripts = []
  try {
    scripts = await window.api.getScripts()
  } catch (err) {
    showToast(err.message || 'Erreur chargement scripts', 'error')
    return
  }

  if (scripts.length === 0) {
    showToast('Aucun script dans la bibliothèque', 'error')
    return
  }

  const options = scripts.map(s =>
    `<option value="${esc(s.id)}">${esc(s.name)}</option>`
  ).join('')

  showModal(`
    <div style="padding:1.5rem;min-width:400px">
      <h2 style="margin:0 0 0.25rem"><i class="ti ti-player-play"></i> Lancer un script</h2>
      <p style="margin:0 0 1.25rem;color:var(--text-secondary);font-size:13px">
        Sur <strong>${count} poste${count > 1 ? 's' : ''}</strong> sélectionné${count > 1 ? 's' : ''}
      </p>
      <div style="margin-bottom:1rem">
        <label class="form-label">Script à exécuter</label>
        <select class="form-input" id="bulk-script-select">${options}</select>
      </div>
      <p style="font-size:12px;color:var(--amber);margin:0 0 1.25rem">
        <i class="ti ti-clock"></i> L'exécution se fera au prochain checkin agent (max 15 min)
      </p>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end">
        <button class="btn" onclick="closeModal()">Annuler</button>
        <button class="btn btn-primary" onclick="bulkRunScriptConfirm()">
          <i class="ti ti-player-play"></i> Lancer
        </button>
      </div>
    </div>`)
}

async function bulkRunScriptConfirm() {
  const select = document.getElementById('bulk-script-select')
  if (!select) return
  const scriptId = select.value
  if (!scriptId) return

  const ids = [..._selected]
  closeModal()

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
    showToast(`Script mis en file sur ${ok} poste${ok > 1 ? 's' : ''}`, 'success')
  } else {
    showToast(`${ok} OK, ${fail} erreur${fail > 1 ? 's' : ''}`, fail === ids.length ? 'error' : 'info')
  }

  clearSelection()
}
