let _items = []

export async function renderStock(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 style="flex:1">${t('mobile.stock.title')}</h1>
      <button class="m-icon-btn" onclick="mStockNew()" title="${t('mobile.stock.btn.new')}">
        <i class="ti ti-plus"></i>
      </button>
    </div>
    <div class="m-search">
      <i class="ti ti-search"></i>
      <input type="text" placeholder="${t('mobile.stock.search_placeholder')}" id="m-stock-q" oninput="mStockFilter()">
    </div>
    <div class="m-scroll-list" id="m-stock-list">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mStockFilter   = renderList
  window.mStockNew      = mStockNew
  window.mSubmitNewItem = mSubmitNewItem

  try {
    const data = await window.api.getStock()
    _items = data.items || data || []
    renderList()
  } catch (err) {
    const list = document.getElementById('m-stock-list')
    if (list) list.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

// ── Création (sheet) ─────────────────────────────────────────────────────────

function mStockNew() {
  const categories = [..._items.map(i => i.category).filter(Boolean)]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()

  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.stock.new.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
      <div>
        <div class="m-label">${t('mobile.stock.new.field.name')} *</div>
        <input class="m-input" id="m-ni-name" placeholder="${t('mobile.stock.new.placeholder.name')}" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${t('mobile.stock.new.field.category')}</div>
        <input class="m-input" id="m-ni-cat" list="m-ni-cats" autocomplete="off" placeholder="${t('mobile.stock.new.placeholder.category')}">
        <datalist id="m-ni-cats">
          ${categories.map(c => `<option value="${esc(c)}">`).join('')}
        </datalist>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div class="m-label">${t('mobile.stock.new.field.unit')}</div>
          <input class="m-input" id="m-ni-unit" value="pcs" autocomplete="off">
        </div>
        <div>
          <div class="m-label">${t('mobile.stock.new.field.threshold')}</div>
          <input class="m-input" id="m-ni-thr" type="number" min="0" value="2">
        </div>
      </div>
      <div>
        <div class="m-label">${t('mobile.stock.new.field.quantity')}</div>
        <input class="m-input" id="m-ni-qty" type="number" min="0" value="0">
      </div>
      <div>
        <div class="m-label">${t('mobile.stock.new.field.description')}</div>
        <textarea class="m-input" id="m-ni-desc" rows="2" style="resize:none"></textarea>
      </div>
      <button class="m-btn-primary" onclick="mSubmitNewItem()">
        ${t('mobile.stock.new.create')}
      </button>
    </div>`)
}

async function mSubmitNewItem() {
  const name        = document.getElementById('m-ni-name')?.value?.trim()
  const category    = document.getElementById('m-ni-cat')?.value?.trim()
  const unit        = document.getElementById('m-ni-unit')?.value?.trim() || 'pcs'
  const quantity    = parseInt(document.getElementById('m-ni-qty')?.value || '0', 10)
  const threshold   = parseInt(document.getElementById('m-ni-thr')?.value || '2', 10)
  const description = document.getElementById('m-ni-desc')?.value?.trim()
  if (!name) {
    window.showToast(t('mobile.stock.new.name_required'), 'error')
    return
  }
  try {
    const item = await window.api.createStockItem({ name, category, unit, quantity, threshold, description })
    _items.push(item)
    window.mCloseSheet()
    renderList()
    window.showToast(t('mobile.stock.new.toast_created'), 'success')
  } catch {
    window.showToast(t('mobile.stock.new.toast_error'), 'error')
  }
}

function renderList() {
  const q = (document.getElementById('m-stock-q')?.value || '').toLowerCase()
  const filtered = _items.filter(i =>
    !q || i.name.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q)
  )

  const list = document.getElementById('m-stock-list')
  if (!list) return

  if (!filtered.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.stock.empty')}</div>`
    return
  }

  list.innerHTML = filtered.map(item => {
    const thr = item.alert_threshold ?? item.threshold ?? 2
    const isEmpty = item.quantity === 0
    const isLow   = !isEmpty && item.quantity <= thr
    const pillCls = isEmpty ? 'm-pill-crit' : isLow ? 'm-pill-warn' : 'm-pill-on'
    const pillTxt = isEmpty ? t('mobile.stock.status.empty') : isLow ? t('mobile.stock.status.low') : t('mobile.stock.status.ok')
    const pct     = item.quantity === 0 ? 0 : Math.min(100, Math.round((item.quantity / Math.max(item.quantity, thr * 2)) * 100))
    const barColor = isEmpty ? 'var(--red)' : isLow ? 'var(--amber)' : 'var(--green)'

    return `
    <div class="m-device-card" onclick="mStockDetail('${esc(item.id)}')">
      <div style="width:32px;height:32px;border-radius:8px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="ti ti-package" style="font-size:14px;color:var(--orange)"></i>
      </div>
      <div class="m-device-info">
        <div class="m-device-name">${esc(item.name)}</div>
        <div class="m-device-sub">${item.category ? esc(item.category) + ' · ' : ''}${item.quantity} ${esc(item.unit || t('mobile.stock.unit_default'))}</div>
        <div class="m-disk-mini" style="width:80px;margin-top:4px">
          <div class="m-disk-mini-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
      </div>
      <span class="m-pill ${pillCls}">${pillTxt}</span>
    </div>`
  }).join('')

  window.mStockDetail = async (id) => {
    const item = _items.find(x => x.id === id)
    if (!item) return

    let movements = []
    try { movements = await window.api.getMovements(id) } catch {}

    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-package" style="color:var(--orange)"></i> ${esc(item.name)}</div>
      <div style="padding:0 4px;display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:24px;font-weight:700">${item.quantity}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${esc(item.unit || t('mobile.stock.unit_default'))}</div>
          </div>
          ${item.category ? `
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:13px;font-weight:600">${esc(item.category)}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${t('mobile.stock.category')}</div>
          </div>` : ''}
        </div>
        ${movements.length ? `
        <div>
          <div class="m-label" style="margin-bottom:8px">${t('mobile.stock.recent_movements')}</div>
          ${movements.slice(0, 5).map(m => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:0.5px solid var(--border)">
              <div style="width:24px;height:24px;border-radius:6px;background:${m.type === 'in' ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="ti ti-arrow-${m.type === 'in' ? 'down' : 'up'}" style="font-size:12px;color:${m.type === 'in' ? 'var(--green)' : 'var(--red)'}"></i>
              </div>
              <div style="flex:1">
                <span style="font-size:13px;font-weight:600;color:${m.type === 'in' ? 'var(--green)' : 'var(--red)'}">${m.type === 'in' ? '+' : '−'}${m.quantity}</span>
                ${m.note ? `<span style="font-size:11px;color:var(--text-tertiary)"> · ${esc(m.note)}</span>` : ''}
              </div>
              <span style="font-size:10px;color:var(--text-tertiary)">${formatRelative(m.created_at)}</span>
            </div>`).join('')}
        </div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="m-btn-primary" style="background:var(--green)" onclick="mStockMove('${esc(item.id)}','in')">
            <i class="ti ti-arrow-down"></i> ${t('mobile.stock.btn.in')}
          </button>
          <button class="m-btn-primary" style="background:var(--red)" onclick="mStockMove('${esc(item.id)}','out')">
            <i class="ti ti-arrow-up"></i> ${t('mobile.stock.btn.out')}
          </button>
        </div>
      </div>`)

    window.mStockMove = (itemId, type) => {
      window.mCloseSheet()
      setTimeout(() => {
        window.mShowSheet(`
          <div class="m-sheet-title">${type === 'in' ? t('mobile.stock.move.in_title') : t('mobile.stock.move.out_title')}</div>
          <div style="padding:0 4px;display:flex;flex-direction:column;gap:12px">
            <div>
              <div class="m-label">${t('mobile.stock.move.quantity')}</div>
              <input class="m-input" id="m-mv-qty" type="number" min="1" value="1">
            </div>
            <div>
              <div class="m-label">${t('mobile.stock.move.note')}</div>
              <input class="m-input" id="m-mv-note" placeholder="${t('mobile.stock.move.note_placeholder')}" autocomplete="off">
            </div>
            <button class="m-btn-primary" onclick="mSubmitMove('${esc(itemId)}','${type}')">${t('mobile.stock.move.confirm')}</button>
          </div>`)
        window.mSubmitMove = async (id, mvType) => {
          const qty  = parseInt(document.getElementById('m-mv-qty')?.value) || 0
          const note = document.getElementById('m-mv-note')?.value?.trim()
          if (!qty) return
          try {
            await window.api.addMovement(id, { type: mvType, quantity: qty, note })
            window.mCloseSheet()
            window.showToast(mvType === 'in' ? t('mobile.stock.toast.in') : t('mobile.stock.toast.out'), 'success')
            // Mettre à jour la quantité locale
            const idx = _items.findIndex(x => x.id === id)
            if (idx !== -1) { _items[idx].quantity += mvType === 'in' ? qty : -qty; renderList() }
          } catch { window.showToast(t('mobile.stock.toast.error'), 'error') }
        }
      }, 250)
    }
  }
}
