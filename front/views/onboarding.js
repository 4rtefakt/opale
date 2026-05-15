// Vue Onboarding / Offboarding — split layout liste / checklist
let _items    = []
let _activeId = null
let _filter   = 'all'

const CONTRACT_TYPES = [
  'CDI', 'CDD', 'Stagiaire', 'Alternant.e', 'Doctorant.e',
  'SVE', 'Service Civique', 'Bénévole', 'Prestataire', 'Autre'
]

export async function renderOnboarding(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('onboarding.title')}</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="openNewModal('offboard')">
          <i class="ti ti-user-minus"></i> ${t('onboarding.btn.offboard')}
        </button>
        <button class="btn btn-primary" onclick="openNewModal('onboard')">
          <i class="ti ti-user-plus"></i> ${t('onboarding.btn.onboard')}
        </button>
      </div>
    </div>
    <div class="view-split" style="flex:1;min-height:0">
      <div class="ticket-list-col">
        <div class="toolbar" style="padding:6px 10px;border-bottom:0.5px solid var(--border);gap:4px">
          ${['all','onboard','offboard','done'].map(f => `
            <button class="btn btn-sm ${_filter===f?'btn-primary':''}" id="of-${f}"
              onclick="setOFilter('${f}')">${t('onboarding.filter.'+f)}</button>`).join('')}
        </div>
        <div class="ticket-list-scroll" id="ob-list"></div>
      </div>
      <div class="ticket-detail-col" id="ob-detail">
        <div class="ticket-detail-empty">
          <i class="ti ti-user-check" style="font-size:32px"></i>
          <span>${t('onboarding.select_hint')}</span>
        </div>
      </div>
    </div>`

  window.setOFilter    = setOFilter
  window.selectOb      = selectOb
  window.toggleCheck   = toggleCheck
  window.runAuto       = runAuto
  window.openNewModal  = openNewModal
  window.markDone      = markDone
  window.searchManager = searchManager
  window.pickManager   = pickManager

  await load()
}

async function load() {
  try {
    const params = {}
    if (_filter === 'onboard')  params.kind = 'onboard'
    if (_filter === 'offboard') params.kind = 'offboard'
    if (_filter === 'done')     params.status = 'done'
    _items = await window.api.getOnboardings(params)
    renderList()
  } catch { showToast(t('error.generic'), 'error') }
}

function renderList() {
  const el = document.getElementById('ob-list')
  if (!el) return
  if (!_items.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem"><i class="ti ti-user-check"></i><p>${t('onboarding.empty')}</p></div>`
    return
  }
  el.innerHTML = _items.map(ob => {
    const pct   = ob.total_checks ? Math.round((ob.done_checks / ob.total_checks) * 100) : 0
    const isOff = ob.kind === 'offboard'
    const done  = ob.status === 'done'
    return `
      <div class="ticket-item ${_activeId === ob.id ? 'active' : ''}" onclick="selectOb('${ob.id}')">
        <div class="ti-header">
          <span class="ti-title">${esc(ob.person_name)}</span>
          <span class="badge ${done ? 'badge-green' : isOff ? 'badge-red' : 'badge-blue'}">
            ${done ? t('onboarding.status.done') : isOff ? t('onboarding.kind.offboard') : t('onboarding.kind.onboard')}
          </span>
        </div>
        <div class="ti-meta">
          ${ob.contract_type ? `<span>${esc(ob.contract_type)}</span>` : ''}
          ${ob.start_date ? `<span>· ${ob.start_date}</span>` : ''}
          ${ob.total_checks ? `<span>· ${ob.done_checks}/${ob.total_checks}</span>` : ''}
        </div>
        ${ob.total_checks ? `
          <div class="qty-bar" style="margin-top:6px;height:3px">
            <div class="qb ${pct === 100 ? '' : 'warn'}" style="width:${pct}%"></div>
          </div>` : ''}
      </div>`
  }).join('')
}

async function selectOb(id) {
  _activeId = id
  renderList()
  const detail = document.getElementById('ob-detail')
  detail.innerHTML = `<div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div>`
  try {
    const ob = await window.api.getOnboarding(id)
    renderDetail(ob)
  } catch { showToast(t('error.generic'), 'error') }
}

function renderDetail(ob) {
  const detail = document.getElementById('ob-detail')
  const done   = ob.status === 'done'
  const isOff  = ob.kind === 'offboard'
  const pct    = ob.checks.length ? Math.round((ob.checks.filter(c => c.done).length / ob.checks.length) * 100) : 0

  // Grouper les checks par section
  const sections = {}
  for (const c of ob.checks) {
    if (!sections[c.section]) sections[c.section] = []
    sections[c.section].push(c)
  }

  detail.innerHTML = `
    <div class="ticket-detail-header">
      <div style="flex:1">
        <div class="ticket-detail-title">${esc(ob.person_name)}</div>
        <div class="ticket-detail-tags">
          <span class="badge ${done ? 'badge-green' : isOff ? 'badge-red' : 'badge-blue'}">
            ${isOff ? t('onboarding.kind.offboard') : t('onboarding.kind.onboard')}
          </span>
          ${ob.contract_type ? `<span class="badge">${esc(ob.contract_type)}</span>` : ''}
          ${done ? `<span class="badge badge-green">${t('onboarding.status.done')}</span>` : ''}
        </div>
      </div>
      ${!done ? `<button class="btn btn-sm btn-primary" onclick="markDone('${ob.id}')">${t('onboarding.btn.mark_done')}</button>` : ''}
    </div>
    <div class="ticket-body-grid" style="grid-template-columns:1fr 240px">
      <!-- Checklist -->
      <div class="ticket-thread-col">
        <div style="padding:12px 20px;border-bottom:0.5px solid var(--border);flex-shrink:0">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:var(--text-tertiary)">
            <span>${ob.checks.filter(c=>c.done).length} / ${ob.checks.length} ${t('onboarding.steps_done')}</span>
            <span>${pct}%</span>
          </div>
          <div class="qty-bar" style="height:6px">
            <div class="qb ${pct === 100 ? '' : 'warn'}" style="width:${pct}%"></div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:20px">
          ${Object.entries(sections).map(([section, checks]) => `
            <div>
              <div class="info-section-title">${esc(section)}</div>
              <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
                ${checks.map(c => checkRow(c, ob)).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>
      <!-- Infos -->
      <div class="ticket-info-col">
        <div class="info-section">
          <div class="info-section-title">${t('onboarding.info.person')}</div>
          ${infoRow(t('onboarding.info.email'),    ob.email)}
          ${infoRow(t('onboarding.info.role'),     ob.role)}
          ${infoRow(t('onboarding.info.dept'),     ob.department)}
          ${infoRow(t('onboarding.info.contract'), ob.contract_type)}
          ${infoRow(t('onboarding.info.start'),    ob.start_date)}
          ${infoRow(t('onboarding.info.end'),      ob.end_date)}
          ${infoRow(t('onboarding.info.manager'),  ob.manager_name)}
        </div>
        ${ob.entra_id_created ? `
          <div class="info-section">
            <div class="info-section-title">${t('onboarding.info.entra')}</div>
            <div style="font-size:11px;font-family:monospace;word-break:break-all;color:var(--text-secondary)">${esc(ob.entra_id_created)}</div>
          </div>` : ''}
        ${ob.notes ? `
          <div class="info-section">
            <div class="info-section-title">${t('onboarding.info.notes')}</div>
            <div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap">${esc(ob.notes)}</div>
          </div>` : ''}
        <div class="info-section">
          <div class="info-section-title">${t('onboarding.info.meta')}</div>
          ${infoRow(t('onboarding.info.created_by'), ob.by_name)}
          ${infoRow(t('onboarding.info.created_at'), formatRelative(ob.created_at))}
        </div>
      </div>
    </div>`
}

function checkRow(c, ob) {
  const doneClass = c.done ? 'ob-check-done' : ''
  const autoBtn   = c.is_auto && !c.done
    ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="runAuto('${ob.id}','${c.id}')" title="${t('onboarding.btn.auto')}">
         <i class="ti ti-bolt"></i>
       </button>` : ''
  const errorBadge = c.auto_error
    ? `<span title="${esc(c.auto_error)}" style="color:var(--red);font-size:11px"><i class="ti ti-alert-circle"></i></span>` : ''

  return `
    <div class="ob-check-row ${doneClass}">
      <input type="checkbox" ${c.done ? 'checked' : ''}
        onchange="toggleCheck('${ob.id}','${c.id}',this.checked)">
      <span class="ob-check-label">${esc(c.label)}</span>
      ${c.is_auto ? `<i class="ti ti-bolt" title="${t('onboarding.auto_label')}" style="color:var(--blue);font-size:12px"></i>` : ''}
      ${errorBadge}
      ${c.done && c.done_by ? `<span style="font-size:10px;color:var(--text-tertiary)">${esc(c.done_by)}</span>` : ''}
      ${autoBtn}
    </div>`
}

function infoRow(label, value) {
  if (!value) return ''
  return `<div class="info-row">
    <span class="label">${label}</span>
    <span class="value">${esc(String(value))}</span>
  </div>`
}

async function toggleCheck(obId, checkId, done) {
  try {
    await window.api.toggleCheck(obId, checkId, done)
    const ob = await window.api.getOnboarding(obId)
    // Mettre à jour dans la liste
    const idx = _items.findIndex(i => i.id === obId)
    if (idx !== -1) {
      _items[idx].done_checks = ob.checks.filter(c => c.done).length
      _items[idx].status      = ob.status
      renderList()
    }
    renderDetail(ob)
  } catch { showToast(t('error.generic'), 'error') }
}

async function runAuto(obId, checkId) {
  const btn = event.currentTarget
  btn.disabled = true
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>'
  try {
    const { result } = await window.api.runAutoCheck(obId, checkId)
    showToast(t('onboarding.toast.auto_ok'), 'success')
    const ob = await window.api.getOnboarding(obId)
    const idx = _items.findIndex(i => i.id === obId)
    if (idx !== -1) {
      _items[idx].done_checks = ob.checks.filter(c => c.done).length
      _items[idx].status = ob.status
      renderList()
    }
    renderDetail(ob)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
    const ob = await window.api.getOnboarding(obId)
    renderDetail(ob)
  }
}

async function markDone(id) {
  try {
    await window.api.updateOnboarding(id, { status: 'done' })
    const idx = _items.findIndex(i => i.id === id)
    if (idx !== -1) { _items[idx].status = 'done'; renderList() }
    const ob = await window.api.getOnboarding(id)
    renderDetail(ob)
    showToast(t('onboarding.toast.done'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function setOFilter(f) {
  _filter = f
  document.querySelectorAll('[id^="of-"]').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.id === `of-${f}`)
  })
  await load()
}

function openNewModal(kind) {
  const isOff = kind === 'offboard'
  showModal(`
    <div class="modal-title">${isOff ? t('onboarding.btn.offboard') : t('onboarding.btn.onboard')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('onboarding.form.name')} *</label>
        <input class="form-input" id="ob-name" placeholder="Prénom Nom">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('onboarding.form.email')}</label>
          <input class="form-input" id="ob-email" type="email" placeholder="nom@exemple.com">
        </div>
        <div class="form-row">
          <label class="form-label">${t('onboarding.form.contract')}</label>
          <select class="form-select" id="ob-contract">
            <option value="">—</option>
            ${CONTRACT_TYPES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('onboarding.form.role')}</label>
          <input class="form-input" id="ob-role">
        </div>
        <div class="form-row">
          <label class="form-label">${t('onboarding.form.dept')}</label>
          <input class="form-input" id="ob-dept">
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${isOff ? t('onboarding.form.end_date') : t('onboarding.form.start_date')}</label>
          <input class="form-input" id="ob-start" type="date">
        </div>
        ${!isOff ? `<div class="form-row">
          <label class="form-label">${t('onboarding.form.end_date')}</label>
          <input class="form-input" id="ob-end" type="date">
        </div>` : '<div></div>'}
      </div>
      <div class="form-row" style="position:relative">
        <label class="form-label">${t('onboarding.form.manager')}</label>
        <input class="form-input" id="ob-manager" placeholder="${t('onboarding.form.manager_placeholder')}"
          autocomplete="off" oninput="searchManager(this.value)">
        <input type="hidden" id="ob-manager-id">
        <div id="ob-manager-drop" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
          background:var(--bg-primary);border:0.5px solid var(--border);border-radius:var(--radius-md);
          box-shadow:0 4px 12px rgba(0,0,0,.15);max-height:180px;overflow-y:auto"></div>
      </div>
      ${isOff ? `<div class="form-row">
        <label class="form-label">${t('onboarding.form.entra_id')}</label>
        <input class="form-input" id="ob-entraid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
      </div>` : ''}
      <div class="form-row">
        <label class="form-label">${t('onboarding.form.notes')}</label>
        <textarea class="form-textarea" id="ob-notes" style="min-height:56px"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitNew('${kind}')">${t('btn.create')}</button>
    </div>`)

  window.submitNew = async (kind) => {
    const name = document.getElementById('ob-name')?.value?.trim()
    if (!name) { showToast(t('onboarding.form.name_required'), 'error'); return }
    const payload = {
      kind,
      person_name:    name,
      email:          document.getElementById('ob-email')?.value?.trim() || null,
      contract_type:  document.getElementById('ob-contract')?.value || null,
      role:           document.getElementById('ob-role')?.value?.trim() || null,
      department:     document.getElementById('ob-dept')?.value?.trim() || null,
      start_date:     document.getElementById('ob-start')?.value || null,
      end_date:       document.getElementById('ob-end')?.value || null,
      manager_name:     document.getElementById('ob-manager')?.value?.trim() || null,
      manager_entra_id: document.getElementById('ob-manager-id')?.value?.trim() || null,
      notes:          document.getElementById('ob-notes')?.value?.trim() || null,
      entra_id_created: document.getElementById('ob-entraid')?.value?.trim() || null,
    }
    try {
      const ob = await window.api.createOnboarding(payload)
      closeModal()
      _items.unshift({ ...ob, total_checks: 0, done_checks: 0 })
      renderList()
      showToast(t('onboarding.toast.created'), 'success')
      selectOb(ob.id)
    } catch { showToast(t('error.generic'), 'error') }
  }
}

let _managerTimer = null
async function searchManager(q) {
  const drop = document.getElementById('ob-manager-drop')
  const hiddenId = document.getElementById('ob-manager-id')
  if (!drop) return
  if (hiddenId) hiddenId.value = ''  // réinitialise si on retape
  clearTimeout(_managerTimer)
  if (!q || q.length < 2) { drop.style.display = 'none'; return }
  _managerTimer = setTimeout(async () => {
    try {
      const users = await window.api.searchAADUsers(q)
      if (!users.length) { drop.style.display = 'none'; return }
      drop.style.display = 'block'
      drop.innerHTML = users.map(u => `
        <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:0.5px solid var(--border)"
          onmousedown="pickManager('${esc(u.entra_id)}','${esc(u.display_name)}')"
          onmouseover="this.style.background='var(--bg-secondary)'"
          onmouseout="this.style.background=''">
          <div style="font-weight:500">${esc(u.display_name)}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">${esc(u.job_title || u.email || '')}</div>
        </div>`).join('')
    } catch { drop.style.display = 'none' }
  }, 300)
}

function pickManager(entraId, name) {
  const input = document.getElementById('ob-manager')
  const hidden = document.getElementById('ob-manager-id')
  const drop   = document.getElementById('ob-manager-drop')
  if (input)  input.value  = name
  if (hidden) hidden.value = entraId
  if (drop)   drop.style.display = 'none'
}
