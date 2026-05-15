let _users    = []
let _filtered = []
const PAGE_SIZE  = 50
const _photoCache = new Map() // entra_id → object URL | 'none'
let _observer = null
let _viewMode = localStorage.getItem('users-view') || 'grid' // 'grid' | 'table'

export async function renderUsers(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('users.title')}</h1>
      <div class="topbar-actions">
        <button class="btn btn-sm" id="users-view-toggle" onclick="toggleUsersView()" title="${t('users.toggle_view')}">
          <i class="ti ${_viewMode === 'grid' ? 'ti-list' : 'ti-layout-grid'}"></i>
        </button>
      </div>
    </div>
    <div style="padding:16px 20px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:0.5px solid var(--border)">
      <div style="position:relative;flex:1;min-width:200px;max-width:340px">
        <i class="ti ti-search" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text-tertiary);font-size:14px;pointer-events:none"></i>
        <input class="form-input" id="user-search" placeholder="${t('users.search')}"
          style="padding-left:30px" oninput="filterUsers()">
      </div>
      <select class="form-input" id="user-dept" style="width:auto" onchange="filterUsers()">
        <option value="">${t('users.all_depts')}</option>
      </select>
      <span id="user-count" style="font-size:12px;color:var(--text-tertiary);margin-left:4px"></span>
    </div>
    <div id="users-container" style="flex:1;overflow-y:auto">
      <div class="empty-state">
        <i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>
      </div>
    </div>`

  window.filterUsers       = filterUsers
  window.toggleUsersView   = toggleUsersView

  try {
    _users = await window.api.getUsers()
    populateDepts()
    filterUsers()
  } catch {
    document.getElementById('users-container').innerHTML =
      `<div class="empty-state"><p>${t('error.generic')}</p></div>`
  }
}

function toggleUsersView() {
  _viewMode = _viewMode === 'grid' ? 'table' : 'grid'
  localStorage.setItem('users-view', _viewMode)
  const icon = document.querySelector('#users-view-toggle i')
  if (icon) icon.className = `ti ${_viewMode === 'grid' ? 'ti-list' : 'ti-layout-grid'}`
  filterUsers()
}

function populateDepts() {
  const select = document.getElementById('user-dept')
  if (!select) return
  const depts = [...new Set(_users.map(u => u.department).filter(Boolean))].sort()
  depts.forEach(d => {
    const o = document.createElement('option')
    o.value = d; o.textContent = d
    select.appendChild(o)
  })
}

function filterUsers() {
  const q    = (document.getElementById('user-search')?.value || '').toLowerCase()
  const dept = document.getElementById('user-dept')?.value || ''
  const wrap = document.getElementById('users-container')
  const count = document.getElementById('user-count')
  if (!wrap) return

  _filtered = _users.filter(u => {
    if (dept && u.department !== dept) return false
    if (q) {
      const hay = `${u.display_name} ${u.email} ${u.job_title || ''} ${u.department || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  if (count) count.textContent = t('users.count', { n: _filtered.length })

  if (!_filtered.length) {
    wrap.innerHTML = `<div class="empty-state"><p>${t('users.empty')}</p></div>`
    return
  }

  if (_viewMode === 'table') {
    renderTable(wrap)
  } else {
    renderGrid(wrap)
  }
}

// ─── Grid view ───

function renderGrid(wrap) {
  wrap.style.padding = '20px'
  wrap.style.display = 'grid'
  wrap.style.gridTemplateColumns = 'repeat(auto-fill,minmax(220px,1fr))'
  wrap.style.gap = '14px'
  wrap.style.alignContent = 'start'
  wrap.innerHTML = ''
  if (_observer) _observer.disconnect()
  appendPage(wrap)
}

function appendPage(wrap) {
  const rendered = wrap.querySelectorAll('.user-card').length
  const page = _filtered.slice(rendered, rendered + PAGE_SIZE)

  const frag = document.createDocumentFragment()
  page.forEach(u => {
    const tmp = document.createElement('div')
    tmp.innerHTML = userCard(u)
    frag.appendChild(tmp.firstElementChild)
  })

  const btn = wrap.querySelector('.load-more-btn')
  if (btn) btn.remove()

  wrap.appendChild(frag)
  observePhotos()

  const nowShown = wrap.querySelectorAll('.user-card').length
  if (nowShown < _filtered.length) {
    const loadMore = document.createElement('button')
    loadMore.className = 'btn load-more-btn'
    loadMore.style.cssText = 'grid-column:1/-1;margin:4px auto;padding:8px 24px'
    loadMore.textContent = `${t('users.load_more')} (${_filtered.length - nowShown})`
    loadMore.onclick = () => appendPage(wrap)
    wrap.appendChild(loadMore)
  }
}

// ─── Table view ───

function renderTable(wrap) {
  wrap.style.padding = '0'
  wrap.style.display = 'block'
  wrap.style.grid = ''
  wrap.style.gap = ''

  wrap.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th style="width:36px"></th>
          <th>${t('users.col_name')}</th>
          <th>${t('users.col_title')}</th>
          <th>${t('users.col_dept')}</th>
          <th>${t('users.col_email')}</th>
          <th>${t('users.col_device')}</th>
        </tr>
      </thead>
      <tbody>
        ${_filtered.map(u => tableRow(u)).join('')}
      </tbody>
    </table>`

  observeTablePhotos(wrap)
}

function tableRow(u) {
  const ini = (u.display_name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  const [fg, bg] = avatarColor(u.display_name || u.entra_id)
  const cached = _photoCache.get(u.entra_id)
  const photoUrl = (cached && cached !== 'none' && cached !== 'loading') ? cached : null
  const avatarInner = photoUrl
    ? `<img style="width:28px;height:28px;border-radius:50%;object-fit:cover" src="${photoUrl}" alt="">`
    : `<div class="ut-av" style="color:${fg};background:${bg}" data-uid="${esc(u.entra_id)}">${esc(ini)}</div>`

  const device = u.device
    ? `<a href="#/postes/${esc(u.device.id)}" style="color:var(--blue);text-decoration:none;font-size:12px"><i class="ti ti-device-laptop"></i> ${esc(u.device.hostname)}</a>`
    : `<span style="color:var(--text-tertiary);font-size:12px">—</span>`

  return `<tr onclick="navigateTo('/users/${esc(u.entra_id)}')" style="cursor:pointer">
    <td>${avatarInner}</td>
    <td style="font-weight:500">${esc(u.display_name || '—')}</td>
    <td style="color:var(--text-secondary)">${esc(u.job_title || '—')}</td>
    <td style="color:var(--text-secondary)">${esc(u.department || '—')}</td>
    <td><a href="mailto:${esc(u.email)}" style="color:var(--blue);text-decoration:none">${esc(u.email || '—')}</a></td>
    <td>${device}</td>
  </tr>`
}

function observeTablePhotos(wrap) {
  if (_observer) _observer.disconnect()
  _observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target
      const uid = el.dataset.uid
      if (!uid || _photoCache.has(uid)) continue
      _photoCache.set(uid, 'loading')
      _observer.unobserve(el)
      window.api.fetchUserPhoto(uid).then(url => {
        _photoCache.set(uid, url || 'none')
        if (!url) return
        document.querySelectorAll(`[data-uid="${uid}"]`).forEach(av => {
          av.outerHTML = `<img style="width:28px;height:28px;border-radius:50%;object-fit:cover" src="${url}" alt="">`
        })
      }).catch(() => _photoCache.set(uid, 'none'))
    }
  }, { rootMargin: '200px' })
  wrap.querySelectorAll('.ut-av[data-uid]').forEach(el => {
    if (!_photoCache.has(el.dataset.uid)) _observer.observe(el)
  })
}

// ─── Grid photo observer ───

function observePhotos() {
  if (_observer) _observer.disconnect()
  _observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target
      const uid = el.dataset.uid
      if (!uid || _photoCache.has(uid)) continue
      _photoCache.set(uid, 'loading')
      _observer.unobserve(el)
      window.api.fetchUserPhoto(uid).then(url => {
        _photoCache.set(uid, url || 'none')
        if (!url) return
        const current = document.querySelector(`.user-card-avatar[data-uid="${uid}"]`)
        if (current) current.innerHTML = `<img class="user-card-photo" src="${url}" alt="">`
      }).catch(() => _photoCache.set(uid, 'none'))
    }
  }, { rootMargin: '100px' })

  document.querySelectorAll('.user-card-avatar[data-uid]').forEach(el => {
    if (!_photoCache.has(el.dataset.uid)) _observer.observe(el)
  })
}

// ─── Card template ───

const AVATAR_COLORS = [
  ['#1D9E75','#E1F5EE'], ['#185FA5','#E6F1FB'], ['#534AB7','#EEEDFE'],
  ['#BA7517','#FAEEDA'], ['#E24B4A','#FCEBEB'], ['#0891b2','#E0F7FA'],
  ['#7c3aed','#EDE9FE'], ['#be185d','#FCE7F3'],
]
function avatarColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function userCard(u) {
  const ini = (u.display_name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  const [fg, bg] = avatarColor(u.display_name || u.entra_id)
  const cached = _photoCache.get(u.entra_id)
  const photoUrl = (cached && cached !== 'none' && cached !== 'loading') ? cached : null
  const avatarInner = photoUrl
    ? `<img class="user-card-photo" src="${photoUrl}" alt="">`
    : `<div class="user-card-initials" style="display:flex;color:${fg};background:${bg}">${esc(ini)}</div>`

  return `
    <div class="user-card" onclick="navigateTo('/users/${esc(u.entra_id)}')" style="cursor:pointer">
      <div class="user-card-avatar" style="background:${bg}" data-uid="${esc(u.entra_id)}" data-fg="${fg}" data-bg="${bg}" data-ini="${esc(ini)}">
        ${avatarInner}
      </div>
      <div class="user-card-body">
        <div class="user-card-name">${esc(u.display_name || '—')}</div>
        ${u.job_title   ? `<div class="user-card-role">${esc(u.job_title)}</div>` : ''}
        ${u.department  ? `<div class="user-card-dept"><i class="ti ti-building"></i>${esc(u.department)}</div>` : ''}
        ${u.office      ? `<div class="user-card-dept"><i class="ti ti-map-pin"></i>${esc(u.office)}</div>` : ''}
        <a class="user-card-email" href="mailto:${esc(u.email)}">${esc(u.email)}</a>
        ${u.device
          ? `<a href="#/postes/${esc(u.device.id)}" class="user-card-device">
               <i class="ti ti-device-laptop"></i>${esc(u.device.hostname)}
             </a>`
          : `<span class="user-card-device user-card-device--none">
               <i class="ti ti-device-laptop"></i>${t('users.no_device')}
             </span>`}
      </div>
    </div>`
}
