let _items = []
let _filter = 'active'
let _activeOb = null  // ob courant ouvert dans le sheet détail

const M_OB_CONTRACT_TYPES = [
  'CDI', 'CDD', 'Stagiaire', 'Alternant.e', 'Doctorant.e',
  'SVE', 'Service Civique', 'Bénévole', 'Prestataire', 'Autre'
]

// jsArg() fourni globalement par mobile-app.js (window.jsArg)
const mObJsArg = window.jsArg

export async function renderOnboarding(el) {
  _filter = 'active'
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 style="flex:1">${t('mobile.onboarding.title')}</h1>
      <button class="m-icon-btn" onclick="mObNew('offboard')" title="${t('mobile.onboarding.btn.new_offboard')}">
        <i class="ti ti-user-minus"></i>
      </button>
      <button class="m-icon-btn" onclick="mObNew('onboard')" title="${t('mobile.onboarding.btn.new_onboard')}">
        <i class="ti ti-user-plus"></i>
      </button>
    </div>
    <div class="m-filters">
      <button class="m-filter-pill active" data-f="active" onclick="mObSetFilter('active',this)">${t('mobile.onboarding.filter.active')}</button>
      <button class="m-filter-pill"        data-f="done"   onclick="mObSetFilter('done',this)">${t('mobile.onboarding.filter.done')}</button>
      <button class="m-filter-pill"        data-f="all"    onclick="mObSetFilter('all',this)">${t('mobile.onboarding.filter.all')}</button>
    </div>
    <div class="m-scroll-list" id="m-ob-list">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mObSetFilter = (f, btn) => {
    _filter = f
    el.querySelectorAll('.m-filter-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    loadOnboardings()
  }
  window.mObNew         = mObNew
  window.mObDetail      = mObDetail
  window.mObToggleCheck = mObToggleCheck
  window.mObRunAuto     = mObRunAuto
  window.mObMarkDone    = mObMarkDone
  window.mObSubmitNew   = mObSubmitNew
  window.mObSearchManager = mObSearchManager
  window.mObPickManager   = mObPickManager

  await loadOnboardings()
}

async function loadOnboardings() {
  const list = document.getElementById('m-ob-list')
  if (!list) return
  list.innerHTML = `<div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>`
  try {
    const params = {}
    if (_filter === 'done') params.status = 'done'
    else if (_filter === 'active') params.status = 'active'
    const data = await window.api.getOnboardings(params)
    _items = data.onboardings || data || []
    renderList()
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function renderList() {
  const list = document.getElementById('m-ob-list')
  if (!list) return

  if (!_items.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.onboarding.empty')}</div>`
    return
  }

  list.innerHTML = _items.map(ob => {
    const done     = ob.status === 'done'
    const isOff    = ob.kind === 'offboard'
    // Fallback : certains payloads ont done_checks/total_checks (liste), d'autres `checks` (détail)
    const totalChecks = ob.total_checks ?? (ob.checks?.length ?? 0)
    const doneChecks  = ob.done_checks  ?? (ob.checks?.filter(c => c.done).length ?? 0)
    const pct      = totalChecks ? Math.round((doneChecks / totalChecks) * 100) : 0
    const pillCls  = done ? 'm-pill-on' : isOff ? 'm-pill-warn' : 'm-pill-off'
    const pillTxt  = done ? t('mobile.onboarding.status.done') : isOff ? t('mobile.onboarding.kind.offboard') : t('mobile.onboarding.kind.onboard')
    const personName = ob.person_name || ob.display_name || ob.email || '—'

    return `
    <div class="m-device-card" onclick="mObDetail('${esc(ob.id)}')">
      <div class="m-device-info">
        <div class="m-device-name">${esc(personName)}</div>
        <div class="m-device-sub">${ob.email ? esc(ob.email) : ''}${ob.contract_type ? ' · ' + esc(ob.contract_type) : ''}</div>
        ${totalChecks ? `
        <div style="display:flex;align-items:center;gap:6px;margin-top:5px">
          <div class="m-disk-mini" style="width:80px">
            <div class="m-disk-mini-fill" style="width:${pct}%;background:${done ? 'var(--green)' : 'var(--blue)'}"></div>
          </div>
          <span style="font-size:10px;color:var(--text-tertiary)">${doneChecks}/${totalChecks}</span>
        </div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span class="m-pill ${pillCls}">${pillTxt}</span>
        <span style="font-size:10px;color:var(--text-tertiary)">${formatRelative(ob.created_at)}</span>
      </div>
    </div>`
  }).join('')
}

// ── Détail (sheet) ─────────────────────────────────────────────────────────

async function mObDetail(id) {
  // Fetch frais pour avoir les checks détaillés
  try {
    _activeOb = await window.api.getOnboarding(id)
    renderDetailSheet()
  } catch {
    window.showToast(t('mobile.onboarding.toast.load_error'), 'error')
  }
}

function renderDetailSheet() {
  const ob = _activeOb
  if (!ob) return
  const done   = ob.status === 'done'
  const isOff  = ob.kind === 'offboard'
  const checks = ob.checks || []
  const doneCount = checks.filter(c => c.done).length
  const pct = checks.length ? Math.round((doneCount / checks.length) * 100) : 0

  // Grouper les checks par section
  const sections = {}
  for (const c of checks) {
    const s = c.section || ''
    if (!sections[s]) sections[s] = []
    sections[s].push(c)
  }

  const personName = ob.person_name || ob.display_name || ob.email || '—'

  window.mShowSheet(`
    <div class="m-sheet-title">
      ${esc(personName)}
      <span class="m-pill ${done ? 'm-pill-on' : isOff ? 'm-pill-warn' : 'm-pill-off'}" style="margin-left:8px;font-size:11px">
        ${done ? t('mobile.onboarding.status.done') : isOff ? t('mobile.onboarding.kind.offboard') : t('mobile.onboarding.kind.onboard')}
      </span>
    </div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:14px;max-height:75vh;overflow-y:auto">

      <!-- Méta -->
      <div style="font-size:12px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px">
        ${ob.email          ? `<div><i class="ti ti-mail" style="font-size:11px;opacity:0.6"></i> ${esc(ob.email)}</div>` : ''}
        ${ob.contract_type  ? `<div><i class="ti ti-id" style="font-size:11px;opacity:0.6"></i> ${esc(ob.contract_type)}</div>` : ''}
        ${ob.role           ? `<div><i class="ti ti-briefcase" style="font-size:11px;opacity:0.6"></i> ${esc(ob.role)}</div>` : ''}
        ${ob.department     ? `<div><i class="ti ti-building" style="font-size:11px;opacity:0.6"></i> ${esc(ob.department)}</div>` : ''}
        ${ob.start_date     ? `<div><i class="ti ti-calendar" style="font-size:11px;opacity:0.6"></i> ${t('mobile.onboarding.start')}: ${esc(ob.start_date)}</div>` : ''}
        ${ob.end_date       ? `<div><i class="ti ti-calendar" style="font-size:11px;opacity:0.6"></i> ${t('mobile.onboarding.end')}: ${esc(ob.end_date)}</div>` : ''}
        ${ob.manager_name   ? `<div><i class="ti ti-user" style="font-size:11px;opacity:0.6"></i> ${t('mobile.onboarding.manager')}: ${esc(ob.manager_name)}</div>` : ''}
        ${ob.notes          ? `<div style="white-space:pre-wrap;margin-top:4px;padding:6px 8px;background:var(--bg-secondary);border-radius:6px">${esc(ob.notes)}</div>` : ''}
      </div>

      <!-- Progression -->
      ${checks.length ? `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-tertiary);margin-bottom:6px">
          <span>${doneCount} / ${checks.length} ${t('mobile.onboarding.steps_done')}</span>
          <span>${pct}%</span>
        </div>
        <div class="m-disk-mini" style="height:6px"><div class="m-disk-mini-fill" style="width:${pct}%;background:${done ? 'var(--green)' : 'var(--blue)'}"></div></div>
      </div>` : ''}

      <!-- Checks groupés par section -->
      ${Object.entries(sections).map(([section, items]) => `
      <div>
        ${section ? `<div class="m-label">${esc(section)}</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:1px">
          ${items.map(c => mObCheckRow(c, ob.id, done)).join('')}
        </div>
      </div>`).join('')}

      <!-- Bouton mark done -->
      ${!done ? `
      <button class="m-btn-primary" style="background:var(--green)" onclick="mObMarkDone('${esc(ob.id)}')">
        <i class="ti ti-check"></i> ${t('mobile.onboarding.btn.mark_done')}
      </button>` : ''}
    </div>`)
}

function mObCheckRow(c, obId, parentDone) {
  // Si l'onboarding est marqué done, on n'autorise plus les toggle (lecture seule)
  const disabled = parentDone
  const checkId = esc(c.id)
  const labelStyle = c.done ? 'color:var(--text-tertiary);text-decoration:line-through' : 'color:var(--text-primary)'
  const errorBadge = c.auto_error
    ? `<span title="${esc(c.auto_error)}" style="color:var(--red);font-size:11px"><i class="ti ti-alert-circle"></i></span>` : ''
  const autoBolt = c.is_auto
    ? `<i class="ti ti-bolt" title="${t('mobile.onboarding.auto_label')}" style="color:var(--blue);font-size:13px"></i>` : ''
  const autoBtn = (c.is_auto && !c.done && !disabled)
    ? `<button class="m-pill m-pill-off" data-runauto="${checkId}" style="border:none;cursor:pointer;font-size:10px;padding:2px 6px"
        onclick="event.stopPropagation();mObRunAuto('${esc(obId)}','${checkId}')" title="${t('mobile.onboarding.btn.run_auto')}">
        <i class="ti ti-bolt" style="font-size:10px"></i>
      </button>` : ''

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:0.5px solid var(--border)"
      ${disabled ? '' : `onclick="mObToggleCheck('${esc(obId)}','${checkId}',${!c.done})"`}
      ${disabled ? '' : 'role="button" style="cursor:pointer"'}>
      <div style="width:22px;height:22px;border-radius:50%;border:2px solid ${c.done ? 'var(--green)' : 'var(--border)'};background:${c.done ? 'var(--green)' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${c.done ? '<i class="ti ti-check" style="font-size:12px;color:#fff"></i>' : ''}
      </div>
      <span style="flex:1;font-size:13px;${labelStyle}">${esc(c.label)}</span>
      ${autoBolt}
      ${errorBadge}
      ${autoBtn}
    </div>`
}

async function mObToggleCheck(obId, checkId, done) {
  try {
    await window.api.toggleCheck(obId, checkId, done)
    // Re-fetch pour avoir la version serveur (peut promote en 'done' si tous les checks)
    _activeOb = await window.api.getOnboarding(obId)
    renderDetailSheet()
    // Synchro liste
    syncListItem(_activeOb)
  } catch {
    window.showToast(t('mobile.onboarding.toast.error'), 'error')
  }
}

async function mObRunAuto(obId, checkId) {
  // Disable visuel du bouton pendant l'exécution
  const btn = document.querySelector(`[data-runauto="${checkId}"]`)
  if (btn) {
    btn.disabled = true
    btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;font-size:10px"></i>'
  }
  try {
    await window.api.runAutoCheck(obId, checkId)
    window.showToast(t('mobile.onboarding.toast.auto_ok'), 'success')
    _activeOb = await window.api.getOnboarding(obId)
    renderDetailSheet()
    syncListItem(_activeOb)
  } catch (err) {
    window.showToast(err.message || t('mobile.onboarding.toast.error'), 'error')
    // Re-fetch quand même pour montrer l'auto_error mis à jour
    try {
      _activeOb = await window.api.getOnboarding(obId)
      renderDetailSheet()
    } catch {}
  }
}

async function mObMarkDone(id) {
  try {
    await window.api.updateOnboarding(id, { status: 'done' })
    _activeOb = await window.api.getOnboarding(id)
    renderDetailSheet()
    syncListItem(_activeOb)
    window.showToast(t('mobile.onboarding.toast.done'), 'success')
  } catch {
    window.showToast(t('mobile.onboarding.toast.error'), 'error')
  }
}

// Met à jour l'item correspondant dans _items + re-render la liste.
// Évite un reload complet (et garde le scroll de la liste).
function syncListItem(ob) {
  const idx = _items.findIndex(x => x.id === ob.id)
  if (idx === -1) return
  const total = ob.checks?.length ?? _items[idx].total_checks ?? 0
  const done  = ob.checks?.filter(c => c.done).length ?? _items[idx].done_checks ?? 0
  _items[idx] = {
    ..._items[idx],
    ...ob,
    total_checks: total,
    done_checks:  done,
  }
  renderList()
}

// ── Création (sheet) ──────────────────────────────────────────────────────

function mObNew(kind) {
  const isOff = kind === 'offboard'
  const titleKey = isOff ? 'mobile.onboarding.new.title_offboard' : 'mobile.onboarding.new.title_onboard'

  window.mShowSheet(`
    <div class="m-sheet-title">${t(titleKey)}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px;max-height:75vh;overflow-y:auto">
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.name')} *</div>
        <input class="m-input" id="m-ob-name" placeholder="${t('mobile.onboarding.new.placeholder.name')}" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.email')}</div>
        <input class="m-input" id="m-ob-email" type="email" placeholder="${t('mobile.onboarding.new.placeholder.email')}" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.contract')}</div>
        <select class="m-input" id="m-ob-contract">
          <option value="">—</option>
          ${M_OB_CONTRACT_TYPES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.role')}</div>
        <input class="m-input" id="m-ob-role" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.dept')}</div>
        <input class="m-input" id="m-ob-dept" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${isOff ? t('mobile.onboarding.new.field.end_date') : t('mobile.onboarding.new.field.start_date')}</div>
        <input class="m-input" id="m-ob-start" type="date">
      </div>
      ${!isOff ? `
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.end_date')}</div>
        <input class="m-input" id="m-ob-end" type="date">
      </div>` : ''}

      <!-- Manager : search AAD -->
      <div style="position:relative">
        <div class="m-label">${t('mobile.onboarding.new.field.manager')}</div>
        <input class="m-input" id="m-ob-manager" placeholder="${t('mobile.onboarding.new.placeholder.manager')}"
          autocomplete="off" oninput="mObSearchManager(this.value)">
        <input type="hidden" id="m-ob-manager-id">
        <div id="m-ob-manager-drop" style="display:none;margin-top:4px;border:0.5px solid var(--border);border-radius:6px;max-height:160px;overflow-y:auto;background:var(--bg-secondary)"></div>
      </div>

      ${isOff ? `
      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.entra_id')}</div>
        <input class="m-input" id="m-ob-entraid" placeholder="xxxxxxxx-xxxx-…" autocomplete="off">
      </div>` : ''}

      <div>
        <div class="m-label">${t('mobile.onboarding.new.field.notes')}</div>
        <textarea class="m-input" id="m-ob-notes" rows="3" style="resize:none"></textarea>
      </div>

      <button class="m-btn-primary" onclick="mObSubmitNew('${kind}')">
        ${t('mobile.onboarding.new.create')}
      </button>
    </div>`)
}

let _mObManagerTimer = null
async function mObSearchManager(q) {
  const drop = document.getElementById('m-ob-manager-drop')
  const hidden = document.getElementById('m-ob-manager-id')
  if (!drop) return
  if (hidden) hidden.value = ''  // réinitialise si on retape après une sélection
  clearTimeout(_mObManagerTimer)
  if (!q || q.length < 2) { drop.style.display = 'none'; drop.innerHTML = ''; return }
  _mObManagerTimer = setTimeout(async () => {
    try {
      const users = await window.api.searchAADUsers(q)
      if (!users.length) { drop.style.display = 'none'; drop.innerHTML = ''; return }
      drop.style.display = 'block'
      drop.innerHTML = users.map(u => `
        <div style="padding:8px 10px;cursor:pointer;font-size:13px;border-bottom:0.5px solid var(--border)"
          onclick="mObPickManager('${esc(u.entra_id)}', ${mObJsArg(u.display_name || '')})">
          <div style="font-weight:500">${esc(u.display_name)}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">${esc(u.job_title || u.email || '')}</div>
        </div>`).join('')
    } catch {
      drop.style.display = 'none'
      drop.innerHTML = ''
    }
  }, 300)
}

function mObPickManager(entraId, name) {
  const input  = document.getElementById('m-ob-manager')
  const hidden = document.getElementById('m-ob-manager-id')
  const drop   = document.getElementById('m-ob-manager-drop')
  if (input)  input.value  = name
  if (hidden) hidden.value = entraId
  if (drop)   { drop.style.display = 'none'; drop.innerHTML = '' }
}

async function mObSubmitNew(kind) {
  const name = document.getElementById('m-ob-name')?.value?.trim()
  if (!name) {
    window.showToast(t('mobile.onboarding.new.name_required'), 'error')
    return
  }
  const isOff = kind === 'offboard'
  const payload = {
    kind,
    person_name:      name,
    email:            document.getElementById('m-ob-email')?.value?.trim() || null,
    contract_type:    document.getElementById('m-ob-contract')?.value || null,
    role:             document.getElementById('m-ob-role')?.value?.trim() || null,
    department:       document.getElementById('m-ob-dept')?.value?.trim() || null,
    start_date:       document.getElementById('m-ob-start')?.value || null,
    end_date:         document.getElementById('m-ob-end')?.value || null,
    manager_name:     document.getElementById('m-ob-manager')?.value?.trim() || null,
    manager_entra_id: document.getElementById('m-ob-manager-id')?.value?.trim() || null,
    notes:            document.getElementById('m-ob-notes')?.value?.trim() || null,
    entra_id_created: isOff ? (document.getElementById('m-ob-entraid')?.value?.trim() || null) : null,
  }
  try {
    const ob = await window.api.createOnboarding(payload)
    window.mCloseSheet()
    _items.unshift({ ...ob, total_checks: ob.checks?.length || 0, done_checks: 0 })
    renderList()
    window.showToast(t('mobile.onboarding.new.toast_created'), 'success')
    // Ouvre directement le détail du nouvel onboarding
    setTimeout(() => mObDetail(ob.id), 200)
  } catch {
    window.showToast(t('mobile.onboarding.new.toast_error'), 'error')
  }
}
