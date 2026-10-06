// Vue Matériel — demandes de matériel et commandes, suivies à part des tickets.
// KPI + filtres + table ; panneau glissant (détail, statut, relances, notes,
// historique) ; modale de création / modification. `#/materiel/<id>` ouvre
// directement le panneau d'une demande.

// Même ordre et mêmes valeurs que api/modules/hardware/lib/statuses.js.
const STATUSES = ['new', 'quote', 'awaiting_choice', 'approval', 'to_order', 'ordered', 'received',
  'to_prepare', 'to_install', 'diagnosis', 'to_test', 'done', 'cancelled']
const CLOSED = ['done', 'cancelled']
const WAITING = ['quote', 'awaiting_choice', 'approval']
const STATUS_BADGE = {
  new: 'badge-gray', quote: 'badge-purple', awaiting_choice: 'badge-purple', approval: 'badge-purple',
  to_order: 'badge-amber', ordered: 'badge-blue', received: 'badge-blue', to_prepare: 'badge-amber',
  to_install: 'badge-amber', diagnosis: 'badge-orange', to_test: 'badge-orange', done: 'badge-green',
  cancelled: 'badge-gray',
}
const PRIORITIES = ['low', 'normal', 'high']

let _items = []
let _state = 'open'
let _q = ''
let _cat = ''
let _panelId = null
let _requesterMap = {}

export async function renderMateriel(container, openId) {
  container.innerHTML = `
    <div class="page"><div class="page-inner wide">
      <div class="page-head">
        <div>
          <div class="page-kicker">${esc(t('hw.kicker'))}</div>
          <h1 class="page-h1">${esc(t('hw.title'))} <span class="muted" id="hw-count"></span></h1>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" onclick="hwOpenForm()"><i class="ti ti-plus"></i> ${esc(t('hw.btn.new'))}</button>
        </div>
      </div>
      <div id="hw-kpis" class="kpi-grid"></div>
      <div class="toolbar">
        <div class="search-bar"><i class="ti ti-search"></i><input placeholder="${esc(t('hw.search'))}" oninput="hwFilter(this.value)"></div>
        <div class="seg" id="hw-state-seg">
          ${['open', 'closed', 'all'].map(s => `<button class="seg-btn${s === _state ? ' active' : ''}" data-state="${s}" onclick="hwSetState('${s}')">${esc(t('hw.state.' + s))}</button>`).join('')}
        </div>
        <select class="form-select" style="width:190px" id="hw-cat-filter" onchange="hwSetCat(this.value)"></select>
      </div>
      <div class="panel" style="padding:0;overflow:auto">
        <table class="table">
          <thead><tr>
            <th>${esc(t('hw.col.request'))}</th>
            <th>${esc(t('hw.col.requester'))}</th>
            <th>${esc(t('hw.col.status'))}</th>
            <th>${esc(t('hw.col.requested'))}</th>
            <th>${esc(t('hw.col.reminders'))}</th>
            <th>${esc(t('hw.col.planned'))}</th>
            <th>${esc(t('hw.col.next'))}</th>
            <th></th>
          </tr></thead>
          <tbody id="hw-tbody"></tbody>
        </table>
      </div>
    </div></div>
    <div class="detail-panel" id="hw-panel" style="width:440px;max-width:100vw">
      <div class="detail-panel-header">
        <span class="detail-panel-title" id="hw-panel-title">—</span>
        <button class="btn btn-sm" onclick="hwClosePanel()" aria-label="${esc(t('btn.close'))}"><i class="ti ti-x"></i></button>
      </div>
      <div class="detail-panel-body" id="hw-panel-body"></div>
    </div>`

  Object.assign(window, {
    hwFilter: (q) => { _q = q.trim().toLowerCase(); renderTable() },
    hwSetState: (s) => {
      _state = s
      document.querySelectorAll('#hw-state-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.state === s))
      renderTable()
    },
    hwSetCat: (c) => { _cat = c; renderTable() },
    hwOpenPanel: openPanel,
    hwClosePanel: closePanel,
    hwOpenForm: openForm,
    hwSetStatus: setStatus,
    hwReminder: addReminder,
    hwAddNote: addNote,
    hwDelete: deleteRequest,
  })

  await load()
  if (openId) openPanel(openId)
}

async function load() {
  try {
    _items = await window.api.getHardwareRequests({ state: 'all' })
  } catch {
    showToast(t('error.generic'), 'error')
    _items = []
  }
  renderKpis()
  renderCategories()
  renderTable()
}

// ─── Formatage ───────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)

function fmtDate(d) {
  if (!d) return '—'
  const loc = window.getLocale?.() === 'en' ? 'en-GB' : 'fr-FR'
  return new Date(d + 'T00:00:00').toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function daysSince(d) {
  if (!d) return null
  return Math.floor((Date.now() - new Date(d + 'T00:00:00').getTime()) / 86_400_000)
}

const statusLabel = (s) => t('hw.status.' + s)
const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] || 'badge-gray'}">${esc(statusLabel(s))}</span>`
const requesterOf = (r) => r.requester_name || r.requester_label || '—'
const isOpen = (r) => !CLOSED.includes(r.status)
const isLate = (r) => isOpen(r) && r.planned_for && r.planned_for < today()

// ─── KPI, filtres, table ─────────────────────────────────────────────────────

function renderKpis() {
  const open = _items.filter(isOpen)
  const c = document.getElementById('hw-count')
  if (c) c.textContent = open.length ? `· ${open.length}` : ''
  const kpi = (icon, val, label, color) => `<div class="kpi">
    <div class="kpi-label"><i class="ti ${icon}"></i> ${esc(label)}</div>
    <div class="kpi-val" style="${color && val ? `color:var(--${color})` : ''}">${val}</div>
  </div>`
  document.getElementById('hw-kpis').innerHTML =
    kpi('ti-inbox', open.length, t('hw.kpi.open'), '') +
    kpi('ti-shopping-cart', open.filter(r => r.status === 'to_order').length, t('hw.kpi.to_order'), 'amber') +
    kpi('ti-hourglass', open.filter(r => WAITING.includes(r.status)).length, t('hw.kpi.waiting'), 'purple') +
    kpi('ti-alarm', open.filter(isLate).length, t('hw.kpi.late'), 'red')
}

function renderCategories() {
  const sel = document.getElementById('hw-cat-filter')
  if (!sel) return
  const cats = [...new Set(_items.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  if (_cat && !cats.includes(_cat)) _cat = ''
  sel.innerHTML = `<option value="">${esc(t('hw.all_categories'))}</option>` +
    cats.map(c => `<option value="${esc(c)}"${c === _cat ? ' selected' : ''}>${esc(c)}</option>`).join('')
}

function matches(r) {
  if (_state === 'open' && !isOpen(r)) return false
  if (_state === 'closed' && isOpen(r)) return false
  if (_cat && r.category !== _cat) return false
  if (!_q) return true
  return [r.title, r.category, requesterOf(r), r.next_action, r.supplier, r.order_ref]
    .some(v => v && String(v).toLowerCase().includes(_q))
}

function renderTable() {
  const tbody = document.getElementById('hw-tbody')
  if (!tbody) return
  const rows = _items.filter(matches)
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><i class="ti ti-shopping-cart"></i><p>${esc(t('hw.empty'))}</p></div></td></tr>`
    return
  }
  tbody.innerHTML = rows.map(r => {
    const age = daysSince(r.requested_at)
    const reminders = r.reminder_count
      ? `<span class="badge badge-orange" title="${esc(t('hw.reminders.last', { date: fmtDate(r.last_reminder_at) }))}">${r.reminder_count}</span>`
      : '<span style="color:var(--text-tertiary)">—</span>'
    return `<tr style="cursor:pointer" onclick="hwOpenPanel('${r.id}')">
      <td>
        <div style="font-weight:500">${r.priority === 'high' ? '<i class="ti ti-point-filled" style="color:var(--red)" title="' + esc(t('hw.priority.high')) + '"></i>' : ''}${esc(r.title)}</div>
        ${r.category ? `<div style="font-size:12px;color:var(--text-tertiary)">${esc(r.category)}</div>` : ''}
      </td>
      <td>${esc(requesterOf(r))}</td>
      <td>${statusBadge(r.status)}</td>
      <td style="white-space:nowrap">${fmtDate(r.requested_at)}${age != null && isOpen(r) ? ` <span style="font-size:12px;color:var(--text-tertiary)">${esc(t('hw.age', { n: age }))}</span>` : ''}</td>
      <td>${reminders}</td>
      <td style="white-space:nowrap${isLate(r) ? ';color:var(--red)' : ''}">${fmtDate(r.planned_for)}</td>
      <td style="font-size:12px;color:var(--text-secondary);max-width:320px">${esc(r.next_action || '')}</td>
      <td>${r.ticket_id ? `<a href="#/tickets/${r.ticket_id}" onclick="event.stopPropagation()" title="${esc(r.ticket_title || t('hw.ticket'))}"><i class="ti ti-ticket"></i></a>` : ''}</td>
    </tr>`
  }).join('')
}

// ─── Panneau de détail ───────────────────────────────────────────────────────

async function openPanel(id) {
  _panelId = id
  document.getElementById('hw-panel-title').textContent = '…'
  document.getElementById('hw-panel-body').innerHTML = `<div style="font-size:13px;color:var(--text-tertiary)">${esc(t('hw.loading'))}</div>`
  document.getElementById('hw-panel').classList.add('open')
  try {
    renderPanel(await window.api.getHardwareRequest(id))
  } catch (err) {
    showToast(err.status === 404 ? t('hw.not_found') : t('error.generic'), 'error')
    closePanel()
  }
}

function closePanel() {
  document.getElementById('hw-panel')?.classList.remove('open')
  _panelId = null
  if (location.hash.startsWith('#/materiel/')) history.replaceState(null, '', '#/materiel')
}

function renderPanel(r) {
  document.getElementById('hw-panel-title').textContent = r.title
  const row = (label, value) => value == null || value === '' ? ''
    : `<div class="info-row"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`
  const amount = r.amount_eur != null
    ? Number(r.amount_eur).toLocaleString(window.getLocale?.() === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: 'EUR' })
    : null
  const hasOrder = r.supplier || r.order_ref || amount || r.budget_code || r.ordered_at || r.received_at

  document.getElementById('hw-panel-body').innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select class="form-select" style="width:auto" onchange="hwSetStatus('${r.id}', this.value)" aria-label="${esc(t('hw.col.status'))}">
        ${STATUSES.map(s => `<option value="${s}"${s === r.status ? ' selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}
      </select>
      <button class="btn btn-sm" onclick="hwOpenForm('${r.id}')"><i class="ti ti-pencil"></i> ${esc(t('hw.btn.edit'))}</button>
      <button class="btn btn-sm" onclick="hwReminder('${r.id}')" title="${esc(t('hw.btn.reminder_hint'))}"><i class="ti ti-bell-ringing"></i> ${esc(t('hw.btn.reminder'))}</button>
    </div>
    <div class="info-section">
      <div class="info-section-title">${esc(t('hw.panel.request'))}</div>
      ${row(t('hw.col.requester'), esc(requesterOf(r)))}
      ${row(t('hw.field.category'), esc(r.category || ''))}
      ${row(t('hw.field.priority'), esc(t('hw.priority.' + r.priority)))}
      ${row(t('hw.col.requested'), fmtDate(r.requested_at))}
      ${row(t('hw.col.planned'), r.planned_for ? fmtDate(r.planned_for) : '')}
      ${row(t('hw.col.reminders'), r.reminder_count ? esc(t('hw.reminders.summary', { n: r.reminder_count, date: fmtDate(r.last_reminder_at) })) : '')}
      ${row(t('hw.ticket'), r.ticket_id ? `<a href="#/tickets/${r.ticket_id}">${esc(r.ticket_title || r.ticket_id.slice(0, 8))}</a>` : '')}
    </div>
    ${r.next_action ? `<div class="info-section">
      <div class="info-section-title">${esc(t('hw.col.next'))}</div>
      <div style="font-size:13px;white-space:pre-wrap">${esc(r.next_action)}</div>
    </div>` : ''}
    ${hasOrder ? `<div class="info-section">
      <div class="info-section-title">${esc(t('hw.panel.order'))}</div>
      ${row(t('hw.field.supplier'), esc(r.supplier || ''))}
      ${row(t('hw.field.order_ref'), esc(r.order_ref || ''))}
      ${row(t('hw.field.amount'), amount ? esc(amount) : '')}
      ${row(t('hw.field.budget_code'), esc(r.budget_code || ''))}
      ${row(t('hw.field.ordered_at'), r.ordered_at ? fmtDate(r.ordered_at) : '')}
      ${row(t('hw.field.received_at'), r.received_at ? fmtDate(r.received_at) : '')}
    </div>` : ''}
    ${r.notes ? `<div class="info-section">
      <div class="info-section-title">${esc(t('hw.field.notes'))}</div>
      <div style="font-size:13px;white-space:pre-wrap">${esc(r.notes)}</div>
    </div>` : ''}
    <div class="info-section">
      <div class="info-section-title">${esc(t('hw.panel.history'))}</div>
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <input class="form-input" id="hw-note-input" placeholder="${esc(t('hw.note_placeholder'))}" onkeydown="if(event.key==='Enter')hwAddNote('${r.id}')">
        <button class="btn btn-sm" onclick="hwAddNote('${r.id}')">${esc(t('hw.btn.add_note'))}</button>
      </div>
      ${(r.events || []).map(eventHtml).join('') || `<div style="font-size:12px;color:var(--text-tertiary)">${esc(t('hw.history.empty'))}</div>`}
    </div>
    <div style="padding-top:8px">
      <button class="btn btn-sm" style="color:var(--red)" onclick="hwDelete('${r.id}')"><i class="ti ti-trash"></i> ${esc(t('hw.btn.delete'))}</button>
    </div>`
}

function eventHtml(e) {
  let text
  if (e.kind === 'created') text = t('hw.history.created', { status: statusLabel(e.to_status) })
  else if (e.kind === 'status') text = t('hw.history.status', { from: statusLabel(e.from_status), to: statusLabel(e.to_status) })
  else if (e.kind === 'reminder') text = t('hw.history.reminder')
  else text = ''
  return `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
    <div>${text ? `<span style="font-weight:500">${esc(text)}</span>` : ''}${e.note ? `${text ? ' · ' : ''}<span style="white-space:pre-wrap">${esc(e.note)}</span>` : ''}</div>
    <div style="color:var(--text-tertiary)">${esc(e.by_name || '')} · ${esc(formatWithDate(e.created_at))}</div>
  </div>`
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function upsert(r) {
  const i = _items.findIndex(x => x.id === r.id)
  if (i === -1) _items.push(r); else _items[i] = { ..._items[i], ...r }
  renderKpis(); renderCategories(); renderTable()
}

async function setStatus(id, status) {
  try {
    upsert(await window.api.updateHardwareRequest(id, { status }))
    showToast(t('hw.toast.saved'), 'success')
    if (_panelId === id) openPanel(id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function addReminder(id) {
  try {
    upsert(await window.api.addHardwareReminder(id, {}))
    showToast(t('hw.toast.reminder'), 'success')
    if (_panelId === id) openPanel(id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function addNote(id) {
  const input = document.getElementById('hw-note-input')
  const note = input?.value.trim()
  if (!note) return
  try {
    await window.api.addHardwareNote(id, note)
    openPanel(id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function deleteRequest(id) {
  const r = _items.find(x => x.id === id)
  if (!confirm(t('hw.confirm_delete', { title: r?.title || '' }))) return
  try {
    await window.api.deleteHardwareRequest(id)
    _items = _items.filter(x => x.id !== id)
    closePanel()
    renderKpis(); renderCategories(); renderTable()
    showToast(t('hw.toast.deleted'), 'success')
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

// ─── Modale création / modification ──────────────────────────────────────────

// Un ticket se colle en lien Opale (…#/tickets/<uuid>) ou en identifiant.
function parseTicketRef(v) {
  const m = String(v || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0].toLowerCase() : null
}

function openForm(id) {
  const r = id ? _items.find(x => x.id === id) : null
  if (id && !r) return
  _requesterMap = {}
  if (r?.requester_entra_id && r.requester_name) _requesterMap[r.requester_name] = r.requester_entra_id
  const v = (k) => esc(r?.[k] ?? '')
  const cats = [...new Set(_items.map(x => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  // Nouvelle demande : « demandée le » = aujourd'hui par défaut.
  const date = (key, label) => `<div class="form-row"><label class="form-label" for="hw-f-${key}">${esc(label)}</label>
    <input class="form-input" type="date" id="hw-f-${key}" value="${!r && key === 'requested_at' ? today() : v(key)}"></div>`
  const text = (key, label, extra = '', value = v(key)) => `<div class="form-row"><label class="form-label" for="hw-f-${key}">${esc(label)}</label>
    <input class="form-input" id="hw-f-${key}" value="${value}" ${extra}></div>`

  showModal(`
    <div class="modal-title">${esc(r ? t('hw.modal.edit') : t('hw.modal.new'))}</div>
    <div style="display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow:auto;padding-right:4px">
      ${text('title', t('hw.field.title'), `placeholder="${esc(t('hw.field.title_placeholder'))}"`)}
      <div class="form-grid">
        <div class="form-row"><label class="form-label" for="hw-f-category">${esc(t('hw.field.category'))}</label>
          <input class="form-input" id="hw-f-category" list="hw-cat-dl" value="${v('category')}">
          <datalist id="hw-cat-dl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="form-row"><label class="form-label" for="hw-f-requester">${esc(t('hw.col.requester'))}</label>
          <input class="form-input" id="hw-f-requester" list="hw-req-dl" autocomplete="off"
            value="${esc(r ? (r.requester_name || r.requester_label || '') : '')}" placeholder="${esc(t('hw.field.requester_placeholder'))}">
          <datalist id="hw-req-dl"></datalist></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label" for="hw-f-status">${esc(t('hw.col.status'))}</label>
          <select class="form-select" id="hw-f-status">${STATUSES.map(s => `<option value="${s}"${s === (r?.status || 'new') ? ' selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select></div>
        <div class="form-row"><label class="form-label" for="hw-f-priority">${esc(t('hw.field.priority'))}</label>
          <select class="form-select" id="hw-f-priority">${PRIORITIES.map(p => `<option value="${p}"${p === (r?.priority || 'normal') ? ' selected' : ''}>${esc(t('hw.priority.' + p))}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        ${date('requested_at', t('hw.col.requested'))}
        ${date('planned_for', t('hw.col.planned'))}
      </div>
      <div class="form-row"><label class="form-label" for="hw-f-next_action">${esc(t('hw.col.next'))}</label>
        <textarea class="form-textarea" id="hw-f-next_action" rows="2">${v('next_action')}</textarea></div>
      ${text('ticket', t('hw.field.ticket'), `placeholder="${esc(t('hw.field.ticket_placeholder'))}"`, esc(r?.ticket_id || ''))}
      <div class="info-section-title" style="margin-top:4px">${esc(t('hw.panel.order'))}</div>
      <div class="form-grid">
        ${text('supplier', t('hw.field.supplier'))}
        ${text('order_ref', t('hw.field.order_ref'))}
      </div>
      <div class="form-grid">
        ${text('amount_eur', t('hw.field.amount'), 'type="number" min="0" step="0.01"')}
        ${text('budget_code', t('hw.field.budget_code'))}
      </div>
      <div class="form-grid">
        ${date('ordered_at', t('hw.field.ordered_at'))}
        ${date('received_at', t('hw.field.received_at'))}
      </div>
      <div class="form-row"><label class="form-label" for="hw-f-notes">${esc(t('hw.field.notes'))}</label>
        <textarea class="form-textarea" id="hw-f-notes" rows="3">${v('notes')}</textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button>
      <button class="btn btn-primary" id="hw-f-submit">${esc(r ? t('btn.save') : t('btn.create'))}</button>
    </div>`)

  wireRequesterField()
  document.getElementById('hw-f-submit').addEventListener('click', () => submitForm(r))
  document.getElementById('hw-f-title').focus()
}

function wireRequesterField() {
  const input = document.getElementById('hw-f-requester')
  const dl = document.getElementById('hw-req-dl')
  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) return
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        users.forEach(u => { _requesterMap[u.display_name] = u.entra_id })
        dl.innerHTML = users.map(u => `<option value="${esc(u.display_name)}">`).join('')
      } catch { /* autocomplete best-effort */ }
    }, 200)
  })
}

async function submitForm(r) {
  const val = (k) => document.getElementById('hw-f-' + k)?.value.trim() ?? ''
  const title = val('title')
  if (!title) { showToast(t('hw.toast.title_required'), 'error'); return }
  const ticketRaw = val('ticket')
  const ticketId = ticketRaw ? parseTicketRef(ticketRaw) : null
  if (ticketRaw && !ticketId) { showToast(t('hw.toast.ticket_invalid'), 'error'); return }
  const requester = val('requester')
  const entraId = requester ? _requesterMap[requester] : null
  const amount = val('amount_eur')

  const body = {
    title,
    category: val('category') || null,
    status: val('status'),
    priority: val('priority'),
    requester_entra_id: entraId || null,
    requester_label: requester && !entraId ? requester : null,
    requested_at: val('requested_at') || null,
    planned_for: val('planned_for') || null,
    next_action: val('next_action') || null,
    ticket_id: ticketId,
    supplier: val('supplier') || null,
    order_ref: val('order_ref') || null,
    amount_eur: amount === '' ? null : Number(amount),
    budget_code: val('budget_code') || null,
    ordered_at: val('ordered_at') || null,
    received_at: val('received_at') || null,
    notes: val('notes') || null,
  }
  try {
    const saved = r
      ? await window.api.updateHardwareRequest(r.id, body)
      : await window.api.createHardwareRequest(body)
    closeModal()
    upsert(saved)
    showToast(t(r ? 'hw.toast.saved' : 'hw.toast.created'), 'success')
    openPanel(saved.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}
