// Vue Stock — KPI + table + panneau glissant + modals
let _items     = []
let _panelId   = null

export async function renderStock(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('stock.title')}</h1>
      <div class="topbar-actions">
        <button class="btn btn-primary" onclick="openNewItemModal()">
          <i class="ti ti-plus"></i> ${t('stock.btn.new')}
        </button>
      </div>
    </div>
    <div class="content-area" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      <div id="stock-kpis" class="kpi-grid" style="grid-template-columns:repeat(4,1fr)"></div>
      <div class="toolbar">
        <input class="search-input" placeholder="${t('stock.search')}" oninput="filterStock(this.value)">
        <select class="form-select" style="width:160px" onchange="filterByCategory(this.value)" id="stock-cat-filter">
          <option value="">${t('stock.all_categories')}</option>
        </select>
      </div>
      <div class="panel" style="padding:0;overflow:hidden">
        <table class="table" id="stock-table">
          <thead>
            <tr>
              <th>${t('stock.col.name')}</th>
              <th>${t('stock.col.category')}</th>
              <th style="width:200px">${t('stock.col.quantity')}</th>
              <th>${t('stock.col.threshold')}</th>
              <th>${t('stock.col.status')}</th>
              <th>${t('stock.col.last_mvt')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="stock-tbody"></tbody>
        </table>
      </div>
    </div>
    <!-- panneau glissant -->
    <div class="detail-panel" id="stock-panel">
      <div class="detail-panel-header">
        <span class="detail-panel-title" id="panel-item-name">—</span>
        <button class="btn btn-sm" onclick="closePanel()"><i class="ti ti-x"></i></button>
      </div>
      <div class="detail-panel-body" id="panel-body"></div>
    </div>`

  window.filterStock      = filterStock
  window.filterByCategory = filterByCategory
  window.openPanel        = openPanel
  window.closePanel       = closePanel
  window.openInModal      = openInModal
  window.openOutModal     = openOutModal
  window.openNewItemModal = openNewItemModal

  await loadStock()
}

async function loadStock() {
  try {
    _items = await window.api.getStock()
    renderKpis()
    populateCategoryFilter()
    renderTable()
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function renderKpis() {
  const total     = _items.length
  const low       = _items.filter(i => i.quantity <= (i.threshold ?? i.alert_threshold ?? 2)).length
  const empty     = _items.filter(i => i.quantity === 0).length
  const ok        = total - low
  document.getElementById('stock-kpis').innerHTML = `
    ${kpi('ti-package',   total,  t('stock.kpi.total'),   '')}
    ${kpi('ti-check',     ok,     t('stock.kpi.ok'),     'green')}
    ${kpi('ti-alert-triangle', low, t('stock.kpi.low'),  'orange')}
    ${kpi('ti-circle-off',empty, t('stock.kpi.empty'),   'red')}`
}

function kpi(icon, val, label, color) {
  return `<div class="kpi-card">
    <div class="kpi-icon" style="${color?`color:var(--${color})`:''}"><i class="ti ${icon}"></i></div>
    <div class="kpi-value">${val}</div>
    <div class="kpi-label">${label}</div>
  </div>`
}

function populateCategoryFilter() {
  const cats = [...new Set(_items.map(i => i.category).filter(Boolean))].sort()
  const sel  = document.getElementById('stock-cat-filter')
  if (!sel) return
  const cur  = sel.value
  sel.innerHTML = `<option value="">${t('stock.all_categories')}</option>` +
    cats.map(c => `<option value="${esc(c)}" ${c===cur?'selected':''}>${esc(c)}</option>`).join('')
}

let _searchQ = ''
let _catQ    = ''

function filterStock(q)    { _searchQ = q.toLowerCase(); renderTable() }
function filterByCategory(c) { _catQ = c; renderTable() }

function renderTable() {
  const tbody = document.getElementById('stock-tbody')
  if (!tbody) return

  const filtered = _items.filter(item => {
    const matchQ   = !_searchQ || item.name.toLowerCase().includes(_searchQ)
    const matchCat = !_catQ   || item.category === _catQ
    return matchQ && matchCat
  })

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="ti ti-package"></i><p>${t('stock.empty')}</p></div></td></tr>`
    return
  }

  tbody.innerHTML = filtered.map(item => {
    const thr     = item.threshold ?? item.alert_threshold ?? 2
    const pct     = item.quantity === 0 ? 0 : Math.min(100, Math.round((item.quantity / Math.max(item.quantity, thr * 2)) * 100))
    const barClass = item.quantity === 0 ? 'danger' : item.quantity <= thr ? 'warn' : ''
    const status   = item.quantity === 0   ? `<span class="badge badge-red">${t('stock.status.empty')}</span>`
                   : item.quantity <= thr  ? `<span class="badge badge-orange">${t('stock.status.low')}</span>`
                   : `<span class="badge badge-green">${t('stock.status.ok')}</span>`

    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <i class="ti ti-package" style="color:var(--text-tertiary)"></i>
          <span style="font-weight:500">${esc(item.name)}</span>
        </div>
      </td>
      <td><span class="badge">${esc(item.category || '—')}</span></td>
      <td>
        <div class="qty-cell">
          <span class="qty-value">${item.quantity}</span>
          <div class="qty-bar"><div class="qb ${barClass}" style="width:${pct}%"></div></div>
          <div class="qty-btns">
            <button onclick="openInModal('${item.id}')" title="${t('stock.btn.in')}">+</button>
            <button onclick="openOutModal('${item.id}')" title="${t('stock.btn.out')}">−</button>
          </div>
        </div>
      </td>
      <td>${thr} ${esc(item.unit || 'pcs')}</td>
      <td>${status}</td>
      <td style="color:var(--text-tertiary);font-size:12px">${item.last_movement_at ? formatRelative(item.last_movement_at) : '—'}</td>
      <td>
        <button class="btn btn-sm" onclick="openPanel('${item.id}')">
          <i class="ti ti-list-details"></i>
        </button>
      </td>
    </tr>`
  }).join('')
}

async function openPanel(id) {
  _panelId = id
  const item = _items.find(i => i.id === id)
  if (!item) return
  document.getElementById('panel-item-name').textContent = item.name
  document.getElementById('panel-body').innerHTML =
    `<div style="color:var(--text-tertiary);font-size:13px">${t('stock.panel.loading')}</div>`
  document.getElementById('stock-panel').classList.add('open')

  try {
    const mvts = await window.api.getMovements(id)
    renderPanelBody(item, mvts)
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function renderPanelBody(item, mvts) {
  const thr = item.threshold ?? item.alert_threshold ?? 2
  document.getElementById('panel-body').innerHTML = `
    <div class="info-section">
      <div class="info-section-title">${t('stock.panel.details')}</div>
      <div class="info-row"><span class="label">${t('stock.col.quantity')}</span><span class="value">${item.quantity} ${esc(item.unit||'pcs')}</span></div>
      <div class="info-row"><span class="label">${t('stock.col.threshold')}</span><span class="value">${thr}</span></div>
      ${item.category ? `<div class="info-row"><span class="label">${t('stock.col.category')}</span><span class="value">${esc(item.category)}</span></div>` : ''}
      ${item.description ? `<div class="info-row"><span class="label">Description</span><span class="value">${esc(item.description)}</span></div>` : ''}
    </div>
    <div>
      <div class="info-section-title">${t('stock.panel.movements')}</div>
      ${mvts.length ? mvts.map(m => `
        <div class="mvt-row">
          <div class="mvt-ico ${m.type==='in'?'mi-in':'mi-out'}">
            <i class="ti ti-${m.type==='in'?'arrow-down':'arrow-up'}"></i>
          </div>
          <div class="mvt-info">
            <div class="mvt-label">${m.by_name || m.user_id || '—'}</div>
            <div class="mvt-sub">${m.note ? esc(m.note) : formatRelative(m.created_at || m.date)}</div>
          </div>
          <div class="mvt-qty" style="color:var(--${m.type==='in'?'green':'red'})">${m.type==='in'?'+':'−'}${m.quantity}</div>
        </div>`).join('')
        : `<div style="color:var(--text-tertiary);font-size:12px;padding-top:8px">${t('stock.panel.no_movements')}</div>`}
    </div>`
}

function closePanel() {
  document.getElementById('stock-panel').classList.remove('open')
  _panelId = null
}

function openInModal(id) {
  const item = _items.find(i => i.id === id)
  showModal(`
    <div class="modal-title">${t('stock.modal.in.title')} — ${esc(item?.name||'')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('stock.modal.quantity')}</label>
        <input class="form-input" id="mvt-qty" type="number" min="1" value="1">
      </div>
      <div class="form-row">
        <label class="form-label">${t('stock.modal.note')}</label>
        <input class="form-input" id="mvt-note" placeholder="${t('stock.modal.note_placeholder')}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitMovement('${id}','in')">${t('stock.btn.in')}</button>
    </div>`)
  window.submitMovement = submitMovement
}

function openOutModal(id) {
  const item = _items.find(i => i.id === id)
  showModal(`
    <div class="modal-title">${t('stock.modal.out.title')} — ${esc(item?.name||'')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('stock.modal.quantity')}</label>
        <input class="form-input" id="mvt-qty" type="number" min="1" max="${item?.quantity||9999}" value="1">
      </div>
      <div class="form-row">
        <label class="form-label">${t('stock.modal.note')}</label>
        <input class="form-input" id="mvt-note" placeholder="${t('stock.modal.note_placeholder')}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitMovement('${id}','out')">${t('stock.btn.out')}</button>
    </div>`)
  window.submitMovement = submitMovement
}

async function submitMovement(id, type) {
  const qty  = parseInt(document.getElementById('mvt-qty')?.value || '0', 10)
  const note = document.getElementById('mvt-note')?.value?.trim()
  if (!qty || qty < 1) { showToast(t('stock.modal.qty_required'), 'error'); return }
  try {
    const { item } = await window.api.addMovement(id, { type, quantity: qty, note })
    const idx = _items.findIndex(i => i.id === id)
    if (idx !== -1) _items[idx] = { ..._items[idx], ...item }
    closeModal()
    renderKpis()
    renderTable()
    showToast(type === 'in' ? t('stock.toast.in') : t('stock.toast.out'), 'success')
    if (_panelId === id) openPanel(id)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

function openNewItemModal() {
  showModal(`
    <div class="modal-title">${t('stock.modal.new.title')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('stock.modal.new.name')}</label>
        <input class="form-input" id="ni-name" placeholder="${t('stock.modal.new.name_placeholder')}">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('stock.col.category')}</label>
          <input class="form-input" id="ni-cat" list="cat-suggestions">
          <datalist id="cat-suggestions">
            ${[..._items.map(i => i.category).filter(Boolean)].filter((v,i,a) => a.indexOf(v)===i)
              .map(c => `<option value="${esc(c)}">`).join('')}
          </datalist>
        </div>
        <div class="form-row">
          <label class="form-label">${t('stock.modal.new.unit')}</label>
          <input class="form-input" id="ni-unit" value="pcs">
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('stock.modal.new.quantity')}</label>
          <input class="form-input" id="ni-qty" type="number" min="0" value="0">
        </div>
        <div class="form-row">
          <label class="form-label">${t('stock.col.threshold')}</label>
          <input class="form-input" id="ni-thr" type="number" min="0" value="2">
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${t('stock.modal.new.description')}</label>
        <textarea class="form-textarea" id="ni-desc"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitNewItem()">${t('btn.create')}</button>
    </div>`)

  window.submitNewItem = async () => {
    const name     = document.getElementById('ni-name')?.value?.trim()
    const category = document.getElementById('ni-cat')?.value?.trim()
    const unit     = document.getElementById('ni-unit')?.value?.trim() || 'pcs'
    const quantity = parseInt(document.getElementById('ni-qty')?.value || '0', 10)
    const threshold = parseInt(document.getElementById('ni-thr')?.value || '2', 10)
    const description = document.getElementById('ni-desc')?.value?.trim()
    if (!name) { showToast(t('stock.modal.new.name_required'), 'error'); return }
    try {
      const item = await window.api.createStockItem({ name, category, unit, quantity, threshold, description })
      _items.push(item)
      closeModal()
      renderKpis()
      populateCategoryFilter()
      renderTable()
      showToast(t('stock.toast.created'), 'success')
    } catch {
      showToast(t('error.generic'), 'error')
    }
  }
}
