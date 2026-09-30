// Parc Linux (état désiré) : onglets Postes (liste paginée côté serveur),
// En attente (file d'approbation, PR 2b), Pré-enregistrements et Import CSV.
// Deep-links : `#/linux?tab=queue` ; tout filtre de la liste dans la query
// (`#/linux?apply_status=failed`) ouvre l'onglet Postes filtré.
const TABS = ['devices', 'queue', 'prereg', 'import']
const PAGE = 50
const DEVICE_FILTERS = ['status', 'profile', 'ring', 'apply_status', 'lagging', 'escrow', 'online', 'q']
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RINGS = ['pilot', 'stable']

let _profiles = []          // slugs du dépôt (GET /linux/profiles), partagés par les onglets
let _tab = 'devices'
const _tabRefresh = {}      // onglet → fonction de rechargement

function hashQuery() {
  return new URLSearchParams((window.location.hash || '').split('?')[1] || '')
}

// Options du sélecteur / datalist de profils : ceux du dépôt + la valeur courante.
export function profileOptions(current) {
  const slugs = _profiles.map(p => p.slug)
  if (current && !slugs.includes(current)) slugs.push(current)
  return slugs
}
export async function loadProfiles() {
  try { _profiles = (await window.api.getLinuxProfiles()).rows } catch { _profiles = [] }
  return _profiles
}
export function profileDatalist(id, current) {
  return `<datalist id="${esc(id)}">${profileOptions(current).map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`
}

export const applyPill = status => {
  if (!status) return '—'
  const cls = { success: 'pill-on', failed: 'pill-crit', partial: 'pill-warn', skipped: 'pill-off' }[status] || 'pill-off'
  return `<span class="status-pill ${cls}"><span class="pill-dot"></span>${esc(t('poste.pull.status.' + status))}</span>`
}
export const shortSha = sha => (sha ? `<code title="${esc(sha)}">${esc(String(sha).slice(0, 7))}</code>` : '—')
// Révision : à jour sur la tête du ring, en retard (mesurable, cf. design §5),
// en cours (différente mais tête pas encore installée), inconnue (pas de tête servie ou jamais appliquée).
export function revisionBadge(d) {
  const rev = d.last_successful_revision
  const badge = (cls, key) => `<span class="badge ${cls}">${esc(t('linux.list.rev.' + key))}</span>`
  if (!d.ring_tip || !rev) return badge('b-closed', 'unknown')
  if (rev === d.ring_tip) return badge('b-done', 'on_tip')
  if (d.lagging) return badge('b-prog', 'lagging')
  return badge('b-open', 'pending')
}

export async function renderLinux(container) {
  const query = hashQuery()
  const initialFilters = Object.fromEntries(DEVICE_FILTERS.filter(k => query.get(k)).map(k => [k, query.get(k)]))
  _tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'devices'
  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left"><h1 class="page-title">${esc(t('nav.linux'))}</h1>
        <div class="seg" id="linux-tabs">${TABS.map(k => `<button class="seg-btn ${k === _tab ? 'active' : ''}" data-tab="${k}" onclick="linuxTab('${k}')">${esc(t('linux.tab.' + k))}${k === 'queue' ? ' <span class="seg-count" id="linux-count">…</span>' : ''}</button>`).join('')}</div>
      </div>
      <div class="topbar-actions"><button class="btn" onclick="linuxRefresh()"><i class="ti ti-refresh"></i> ${esc(t('linux.queue.refresh'))}</button></div>
    </div>
    <div id="linux-pane" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`

  // Le compteur de l'onglet En attente sert aussi le badge de navigation.
  const setPending = n => {
    const el = container.querySelector('#linux-count')
    if (el) { el.textContent = n; el.classList.toggle('hot', n > 0) }
    window.setLinuxBadge(n)
  }
  const renderTab = () => {
    const pane = container.querySelector('#linux-pane')
    if (!pane) return
    if (_tab === 'queue')       renderQueue(pane, setPending)
    else if (_tab === 'prereg') renderPreregistrations(pane)
    else if (_tab === 'import') renderImport(pane)
    else                        renderDevices(pane, initialFilters)
  }
  window.linuxTab = tab => {
    if (!TABS.includes(tab)) return
    _tab = tab
    container.querySelectorAll('#linux-tabs .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
    renderTab()
  }
  window.linuxRefresh = () => _tabRefresh[_tab]?.()
  window.api.getLinuxEnrollmentsCount().then(c => setPending(c.pending)).catch(() => {})

  await loadProfiles()
  renderTab()
}

// ─── Onglet Postes ──────────────────────────────────────────────────────────

function renderDevices(pane, initialFilters) {
  const filters = Object.fromEntries(DEVICE_FILTERS.map(k => [k, initialFilters[k] || '']))
  let rows = [], total = 0, version = 0
  const selected = new Set()
  const select = (name, options) => `
    <select class="form-select" style="width:auto;height:34px;font-size:12px;padding:0 8px" data-filter="${name}" onchange="lxDevFilter(this.dataset.filter,this.value)">
      <option value="">${esc(t('linux.list.filter.' + name))}</option>
      ${options.map(([v, label]) => `<option value="${esc(v)}" ${filters[name] === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
    </select>`
  pane.innerHTML = `
    <div class="toolbar">
      <div class="search-bar"><i class="ti ti-search"></i><input type="text" id="lxd-q" placeholder="${esc(t('linux.list.search'))}" value="${esc(filters.q)}" oninput="lxDevSearch(this.value)"></div>
      ${select('status', [['approved', t('linux.list.status.approved')], ['revoked', t('linux.list.status.revoked')]])}
      ${select('profile', profileOptions(filters.profile).map(s => [s, s]))}
      ${select('ring', RINGS.map(r => [r, t('linux.queue.ring.' + r)]))}
      ${select('apply_status', ['success', 'failed', 'partial', 'skipped'].map(s => [s, t('poste.pull.status.' + s)]))}
      ${select('lagging', [['true', t('linux.list.rev.lagging')], ['false', t('linux.list.filter.not_lagging')]])}
      ${select('escrow', [['missing', t('linux.list.escrow.missing')], ['ok', t('linux.list.escrow.ok')]])}
      ${select('online', [['true', t('status.online')], ['false', t('status.offline')]])}
      <span class="topbar-sub" id="lxd-total" style="margin-left:auto"></span>
    </div>
    <div class="bulk-bar" id="lxd-bulk">
      <span class="bulk-count" id="lxd-selected"></span>
      <div class="bulk-actions">
        <button class="btn" onclick="lxDevAssign()"><i class="ti ti-file-settings"></i> ${esc(t('linux.list.bulk.assign'))}</button>
        <button class="btn btn-danger" onclick="lxDevRevoke()"><i class="ti ti-key-off"></i> ${esc(t('linux.list.bulk.revoke'))}</button>
        <button class="btn" onclick="lxDevSelectAll(false)"><i class="ti ti-x"></i> ${esc(t('linux.list.bulk.clear'))}</button>
      </div>
    </div>
    <div class="table-wrap" id="lxd-table"></div>`
  const table = pane.querySelector('#lxd-table')

  function updateSelection() {
    pane.querySelector('#lxd-bulk').classList.toggle('show', selected.size > 0)
    pane.querySelector('#lxd-selected').textContent = t('linux.queue.selected', { n: selected.size })
    const all = pane.querySelector('#lxd-all')
    if (all) {
      all.checked = rows.length > 0 && selected.size === rows.length
      all.indeterminate = selected.size > 0 && selected.size < rows.length
    }
    table.querySelectorAll('[data-device]').forEach(cb => {
      cb.checked = selected.has(cb.dataset.device)
      cb.closest('tr').classList.toggle('selected', cb.checked)
    })
  }

  const userCell = d => d.assigned_user
    ? `<a href="#/users/${esc(d.assigned_user.entra_id)}" class="nav-link">${esc(d.assigned_user.display_name || d.assigned_user.email || d.assigned_user.entra_id)}</a>`
    : `<span style="color:var(--text-tertiary)">${esc(t('poste.facts.unassigned'))}</span>`
  const rowHtml = d => `
    <tr>
      <td class="td-check"><input type="checkbox" data-device="${esc(d.id)}" aria-label="${esc(t('linux.list.select', { hostname: d.hostname }))}" onchange="lxDevSelect(${jsArg(d.id)},this.checked)"></td>
      <td>${userCell(d)}</td>
      <td><a href="#/linux/${esc(d.id)}" class="nav-link hostname">${esc(d.hostname)}</a>${d.key?.status === 'revoked' ? ` <span class="badge badge-red">${esc(t('linux.list.status.revoked'))}</span>` : ''}</td>
      <td style="font-family:var(--font-mono,monospace);font-size:11px">${esc(d.serial || '—')}</td>
      <td>${esc(d.os || '—')}</td>
      <td>${esc(d.profile || '—')}${d.profile_in_repo === false ? ` <span class="badge badge-orange" title="${esc(t('linux.list.profile_missing_hint'))}">${esc(t('linux.list.profile_missing'))}</span>` : ''}</td>
      <td>${d.ring ? esc(t('linux.queue.ring.' + d.ring)) : '—'}</td>
      <td style="white-space:nowrap">${shortSha(d.last_revision_applied)} ${revisionBadge(d)}</td>
      <td style="white-space:nowrap">${applyPill(d.last_apply_status)}${d.last_apply_at ? ` <span style="font-size:11px;color:var(--text-tertiary)">${esc(formatRelative(d.last_apply_at))}</span>` : ''}</td>
      <td style="white-space:nowrap;font-size:11px;color:var(--text-tertiary)"><span class="sdot ${d.online ? 'dot-on' : 'dot-off'}" style="display:inline-block;margin-right:6px;vertical-align:middle"></span>${esc(formatRelative(d.last_seen))}</td>
      <td>${d.needs_escrow ? `<span class="badge badge-red">${esc(t('linux.list.escrow.missing'))}</span>` : `<span class="badge b-closed">${esc(t('linux.list.escrow.ok'))}</span>`}</td>
    </tr>`

  function paint() {
    pane.querySelector('#lxd-total').textContent = t('audit.count', { n: rows.length, total })
    table.innerHTML = rows.length ? `
      <table><thead><tr>
        <th class="td-check"><input type="checkbox" id="lxd-all" aria-label="${esc(t('linux.queue.select_all'))}" onchange="lxDevSelectAll(this.checked)"></th>
        ${['user', 'hostname', 'serial', 'os', 'profile', 'ring', 'revision', 'last_apply', 'last_seen', 'escrow'].map(k => `<th>${esc(t('linux.list.col.' + k))}</th>`).join('')}
      </tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>
      ${rows.length < total ? `<div style="display:flex;justify-content:center;padding:12px"><button class="btn" onclick="lxDevMore()">${esc(t('audit.load_more'))}</button></div>` : ''}`
      : `<div class="empty-state"><i class="ti ti-brand-debian"></i><p>${esc(t('linux.list.empty'))}</p></div>`
    updateSelection()
  }

  async function load(append) {
    const v = ++version
    if (!append) {
      table.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2"></i> ${esc(t('linux.queue.loading'))}</div>`
      selected.clear()
    }
    try {
      const page = await window.api.getLinuxDevices({ ...filters, limit: PAGE, offset: append ? rows.length : 0 })
      if (!table.isConnected || v !== version) return
      rows = append ? [...rows, ...page.rows] : page.rows
      total = page.total
      paint()
    } catch (err) {
      if (table.isConnected && v === version) table.innerHTML = `<div class="empty-state"><p>${esc(err.message || t('error.generic'))}</p><button class="btn" onclick="linuxRefresh()">${esc(t('linux.queue.refresh'))}</button></div>`
    }
  }

  let searchTimer
  window.lxDevSearch = value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = value.trim(); load(false) }, 300) }
  window.lxDevFilter = (name, value) => { filters[name] = value; load(false) }
  window.lxDevMore = () => load(true)
  window.lxDevSelect = (id, checked) => { checked ? selected.add(id) : selected.delete(id); updateSelection() }
  window.lxDevSelectAll = checked => { rows.forEach(r => checked ? selected.add(r.id) : selected.delete(r.id)); updateSelection() }

  // Assignation groupée : profil et/ou ring (champ vide = inchangé).
  window.lxDevAssign = () => {
    const ids = [...selected]
    if (!ids.length) return
    showModal(`
      <form id="lxd-assign-form">
        <div class="modal-title">${esc(t('linux.list.bulk.assign'))} · ${esc(t('linux.queue.selected', { n: ids.length }))}</div>
        <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:12px">
          <div class="form-row"><label class="form-label" for="lxd-assign-profile">${esc(t('linux.queue.profile'))}</label>
            <input class="form-input" id="lxd-assign-profile" list="lxd-assign-profiles" maxlength="64" pattern="^[a-z0-9][a-z0-9\\-]{0,63}$" placeholder="${esc(t('linux.list.bulk.unchanged'))}" title="${esc(t('linux.queue.profile_hint'))}">${profileDatalist('lxd-assign-profiles')}</div>
          <div class="form-row"><label class="form-label" for="lxd-assign-ring">${esc(t('linux.queue.ring'))}</label>
            <select class="form-select" id="lxd-assign-ring"><option value="">${esc(t('linux.list.bulk.unchanged'))}</option>${RINGS.map(r => `<option value="${r}">${esc(t('linux.queue.ring.' + r))}</option>`).join('')}</select></div>
          <p id="lxd-assign-error" role="alert" style="color:var(--red);margin:0"></p>
          <div class="modal-footer"><button type="button" class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button><button type="submit" class="btn btn-primary">${esc(t('btn.apply'))}</button></div>
        </fieldset>
      </form>`)
    const form = document.getElementById('lxd-assign-form')
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const fieldset = form.querySelector('fieldset')
      const error = form.querySelector('#lxd-assign-error')
      const body = { ids }
      const profile = form.querySelector('#lxd-assign-profile').value.trim()
      const ring = form.querySelector('#lxd-assign-ring').value
      if (profile) body.profile = profile
      if (ring) body.ring = ring
      if (!profile && !ring) { error.textContent = t('linux.list.bulk.nothing'); return }
      fieldset.disabled = true
      try {
        const result = await window.api.assignLinuxDevicesBulk(body)
        showBulkOutcome(result, id => rows.find(r => r.id === id)?.hostname || id)
        if (table.isConnected) load(false)
      } catch (err) {
        error.textContent = err.message || t('error.generic')
        fieldset.disabled = false
      }
    })
  }

  // Révocation : un POST par poste (motif texte ≥ 5 caractères), résumé en toast.
  window.lxDevRevoke = () => {
    const ids = [...selected]
    if (!ids.length) return
    revokeReasonModal(ids.length, async reason => {
      let ok = 0
      const failed = []
      for (const id of ids) {
        try { await window.api.revokeLinuxDevice(id, reason); ok++ }
        catch (err) { failed.push(`${rows.find(r => r.id === id)?.hostname || id} : ${err.message || t('error.generic')}`) }
      }
      showToast(t('linux.list.revoke.result', { ok, failed: failed.length }), failed.length ? 'error' : 'success')
      if (failed.length) showModal(`<div class="modal-title">${esc(t('linux.list.bulk.revoke'))}</div><div class="pick-list">${failed.map(f => `<div class="pick-row"><div class="s">${esc(f)}</div></div>`).join('')}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">${esc(t('btn.close'))}</button></div>`)
      if (table.isConnected) load(false)
    })
  }

  _tabRefresh.devices = () => load(false)
  load(false)
}

// Modal de motif de révocation (chaîne libre, contrat linuxRevokeDevice) ;
// `onConfirm(reason)` est appelé après fermeture.
export function revokeReasonModal(n, onConfirm) {
  showModal(`
    <form id="lx-revoke-form">
      <div class="modal-title">${esc(t('linux.list.bulk.revoke'))}</div>
      <p>${esc(t('linux.list.revoke.confirm', { n }))}</p>
      <div class="form-row"><label class="form-label" for="lx-revoke-reason">${esc(t('linux.list.revoke.reason'))}</label>
        <textarea class="form-textarea" id="lx-revoke-reason" required minlength="5" maxlength="500"></textarea></div>
      <div class="modal-footer"><button type="button" class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button><button type="submit" class="btn btn-danger">${esc(t('linux.list.bulk.revoke'))}</button></div>
    </form>`)
  const form = document.getElementById('lx-revoke-form')
  form.addEventListener('submit', event => {
    event.preventDefault()
    const reason = form.querySelector('#lx-revoke-reason').value.trim()
    if (reason.length < 5) return
    closeModal()
    onConfirm(reason)
  })
}

// Résultat d'un lot (BulkResult) : toast, et la liste des erreurs par ligne s'il y en a.
export function showBulkOutcome(result, labelOf = id => id) {
  if (!result.errors?.length) {
    closeModal()
    showToast(t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }), 'success')
    return
  }
  showModal(`<div class="modal-title">${esc(t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }))}</div>
    <div class="pick-list">${result.errors.map(e => `<div class="pick-row"><div class="t">${esc(labelOf(e.id))} · ${esc(e.code)}</div><div class="s">${esc(e.message || codeLabel(e.code))}</div></div>`).join('')}</div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${esc(t('btn.close'))}</button></div>`)
}

// Libellé d'un code d'erreur de lot (import, migration, assignation) ; le code brut sinon.
export function codeLabel(code) {
  const key = 'linux.code.' + code
  const label = t(key)
  return label === key ? code : label
}

// Recherche d'utilisateur avec pick-list (même recherche que le demandeur des
// tickets), partagée par la file d'approbation et la fiche du poste Linux.
// `handler` : nom du handler inline exposé sur window pour le clic sur une
// ligne. `onPick(user | null)` : null dès qu'on retape (ne jamais envoyer un
// utilisateur invisible), { entra_id, display_name } au choix. `onError(message)`
// en cas d'échec de la recherche. Retourne { clear() } pour vider le champ.
export function bindUserPicker(input, list, handler, onPick, onError) {
  let timer, searchVersion = 0
  const pick = user => {
    ++searchVersion
    onPick(user)
    input.value = user?.display_name || ''
    list.style.display = 'none'
  }
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const version = ++searchVersion
    onPick(null)
    const q = input.value.trim()
    list.style.display = 'none'
    if (q.length < 2) return
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        if (!input.isConnected || version !== searchVersion) return
        list.innerHTML = users.map(u => `<button type="button" class="pick-row" onclick="${handler}(${jsArg(u.entra_id)},${jsArg(u.display_name || u.email)})"><span class="t">${esc(u.display_name || u.email)}</span><span class="s">${esc(u.email || '')}</span></button>`).join('') || `<div class="pick-row">${esc(t('tickets.assignee.no_match'))}</div>`
        list.style.display = ''
      } catch (err) {
        if (input.isConnected && version === searchVersion) onError(err.message)
      }
    }, 200)
  })
  window[handler] = (entra_id, display_name) => pick({ entra_id, display_name })
  return { clear: () => pick(null) }
}

// ─── Onglet Pré-enregistrements ─────────────────────────────────────────────

function renderPreregistrations(pane) {
  let consumed = false, rows = [], total = 0, version = 0
  pane.innerHTML = `
    <div class="toolbar">
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><input type="checkbox" id="lxp-consumed" onchange="lxPreToggle(this.checked)"> ${esc(t('linux.prereg.show_consumed'))}</label>
      <span class="topbar-sub" id="lxp-total" style="margin-left:auto"></span>
    </div>
    <div class="table-wrap" id="lxp-table"></div>`
  const table = pane.querySelector('#lxp-table')

  function paint() {
    pane.querySelector('#lxp-total').textContent = t('audit.count', { n: rows.length, total })
    table.innerHTML = rows.length ? `
      <table><thead><tr>${['serial', 'hostname', 'profile', 'ring', 'user', 'note', 'created', 'conversion', 'actions'].map(k => `<th>${esc(t('linux.prereg.col.' + k))}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(p => `
        <tr class="${p.consumed_at ? 'tr-muted' : ''}">
          <td style="font-family:var(--font-mono,monospace);font-size:11px">${esc(p.serial)}</td>
          <td>${esc(p.hostname || '—')}</td>
          <td>${esc(p.profile)}</td>
          <td>${esc(t('linux.queue.ring.' + p.ring))}</td>
          <td>${p.assigned_user ? `<a href="#/users/${esc(p.assigned_user.entra_id)}" class="nav-link">${esc(p.assigned_user.display_name || p.assigned_user.email || p.assigned_user.entra_id)}</a>` : '—'}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.note || '')}">${esc(p.note || '—')}</td>
          <td style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${esc(formatRelative(p.created_at))}${p.created_by ? ` · ${esc(p.created_by)}` : ''}${p.consumed_at ? `<br>${esc(t('linux.prereg.consumed', { when: formatRelative(p.consumed_at) }))}` : ''}</td>
          <td>${p.matches_device ? `<span class="badge badge-blue" title="${esc(t('linux.prereg.convert_hint'))}">${esc(t('linux.prereg.will_convert', { hostname: p.matches_device.hostname }))}</span>` : ''}</td>
          <td style="text-align:right">${p.consumed_at ? '' : `<button class="btn btn-sm" style="color:var(--red)" onclick="lxPreDelete(${jsArg(p.id)},${jsArg(p.serial)})"><i class="ti ti-trash"></i></button>`}</td>
        </tr>`).join('')}</tbody></table>
      ${rows.length < total ? `<div style="display:flex;justify-content:center;padding:12px"><button class="btn" onclick="lxPreMore()">${esc(t('audit.load_more'))}</button></div>` : ''}`
      : `<div class="empty-state"><i class="ti ti-file-import"></i><p>${esc(t('linux.prereg.empty'))}</p></div>`
  }

  async function load(append) {
    const v = ++version
    if (!append) table.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2"></i> ${esc(t('linux.queue.loading'))}</div>`
    try {
      const page = await window.api.getLinuxPreregistrations({ consumed, limit: PAGE, offset: append ? rows.length : 0 })
      if (!table.isConnected || v !== version) return
      rows = append ? [...rows, ...page.rows] : page.rows
      total = page.total
      paint()
    } catch (err) {
      if (table.isConnected && v === version) table.innerHTML = `<div class="empty-state"><p>${esc(err.message || t('error.generic'))}</p></div>`
    }
  }

  window.lxPreToggle = checked => { consumed = checked; load(false) }
  window.lxPreMore = () => load(true)
  window.lxPreDelete = async (id, serial) => {
    if (!confirm(t('linux.prereg.delete_confirm', { serial }))) return
    try {
      await window.api.deleteLinuxPreregistration(id)
      showToast(t('linux.prereg.deleted'), 'info')
      if (table.isConnected) load(false)
    } catch (err) { showToast(err.message || t('error.generic'), 'error') }
  }
  _tabRefresh.prereg = () => load(false)
  load(false)
}

// ─── Onglet Import ──────────────────────────────────────────────────────────

const CSV_COLUMNS = ['serial', 'hostname', 'profile', 'ring', 'email']

// Validation client (miroir des règles du serveur) : code ou null.
export function validateImportRow(row) {
  if (!row.serial || row.serial.length > 100) return 'INVALID_SERIAL'
  if (!PROFILE_RE.test(row.profile || '')) return 'INVALID_PROFILE'
  if (!RINGS.includes(row.ring)) return 'INVALID_RING'
  if (row.hostname && !HOSTNAME_RE.test(row.hostname)) return 'INVALID_HOSTNAME'
  if (row.email && (!EMAIL_RE.test(row.email) || row.email.length > 200)) return 'INVALID_EMAIL'
  return null
}

// CSV `serial,hostname,profile,ring,email` : en-tête facultatif (colonnes
// dans n'importe quel ordre si présent), séparateur virgule ou point-virgule,
// guillemets simples retirés. Lignes vides ignorées.
export function parseImportCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ','
  const cells = line => line.split(sep).map(c => c.trim().replace(/^"(.*)"$/, '$1').trim())
  let columns = CSV_COLUMNS
  const first = cells(lines[0]).map(c => c.toLowerCase())
  if (first.includes('serial') && first.every(c => CSV_COLUMNS.includes(c) || c === '')) {
    columns = first
    lines.shift()
  }
  return lines.map(line => {
    const values = cells(line)
    const row = {}
    columns.forEach((name, i) => { if (name && values[i]) row[name] = values[i] })
    return { serial: row.serial || '', hostname: row.hostname || '', profile: (row.profile || '').toLowerCase(), ring: (row.ring || '').toLowerCase(), email: row.email || '' }
  })
}

function renderImport(pane) {
  let pending = []      // lignes en aperçu : { ...row, error }
  let results = null    // dernier import : [{ index, serial, code, ok }]
  pane.innerHTML = `
    <div class="page-body">
      <div class="panel">
        <div class="panel-header">${esc(t('linux.import.row_title'))}</div>
        <form id="lxi-row-form" style="padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
          <div class="form-row"><label class="form-label" for="lxi-serial">${esc(t('linux.queue.serial'))}</label><input class="form-input" id="lxi-serial" required maxlength="100"></div>
          <div class="form-row"><label class="form-label" for="lxi-hostname">${esc(t('linux.queue.hostname'))}</label><input class="form-input" id="lxi-hostname" maxlength="63" pattern="^[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?$"></div>
          <div class="form-row"><label class="form-label" for="lxi-profile">${esc(t('linux.queue.profile'))}</label><input class="form-input" id="lxi-profile" list="lxi-profiles" required maxlength="64" pattern="^[a-z0-9][a-z0-9\\-]{0,63}$" title="${esc(t('linux.queue.profile_hint'))}">${profileDatalist('lxi-profiles')}</div>
          <div class="form-row"><label class="form-label" for="lxi-ring">${esc(t('linux.queue.ring'))}</label><select class="form-select" id="lxi-ring">${RINGS.map(r => `<option value="${r}">${esc(t('linux.queue.ring.' + r))}</option>`).join('')}</select></div>
          <div class="form-row"><label class="form-label" for="lxi-email">${esc(t('linux.import.email'))}</label><input class="form-input" id="lxi-email" type="email" maxlength="200"></div>
          <button type="submit" class="btn btn-primary"><i class="ti ti-plus"></i> ${esc(t('linux.import.add_row'))}</button>
        </form>
      </div>
      <div class="panel">
        <div class="panel-header">${esc(t('linux.import.csv_title'))}</div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
          <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('linux.import.csv_hint'))}</p>
          <textarea class="form-textarea" id="lxi-csv" rows="6" style="font-family:var(--font-mono,monospace);font-size:12px" placeholder="serial,hostname,profile,ring,email&#10;PF3ABC12,lx-dupont,field-researcher,stable,j.dupont@example.org"></textarea>
          <div><button class="btn" onclick="lxImpParse()"><i class="ti ti-table-import"></i> ${esc(t('linux.import.parse'))}</button></div>
        </div>
      </div>
      <div class="panel" id="lxi-preview"></div>
      <div class="panel" id="lxi-results" style="display:none"></div>
    </div>`

  function paintPreview() {
    const el = pane.querySelector('#lxi-preview')
    const valid = pending.filter(r => !r.error).length
    el.innerHTML = `
      <div class="panel-header">${esc(t('linux.import.preview', { n: pending.length }))}
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-sm" onclick="lxImpClear()" ${pending.length ? '' : 'disabled'}>${esc(t('linux.import.clear'))}</button>
          <button class="btn btn-sm btn-primary" id="lxi-submit" onclick="lxImpSubmit()" ${valid ? '' : 'disabled'}><i class="ti ti-upload"></i> ${esc(t('linux.import.submit', { n: valid }))}</button>
        </div>
      </div>
      ${pending.length ? `<div class="table-wrap"><table><thead><tr><th>#</th>${CSV_COLUMNS.map(c => `<th>${esc(t('linux.import.col.' + c))}</th>`).join('')}<th>${esc(t('linux.import.col.validation'))}</th><th></th></tr></thead>
        <tbody>${pending.map((r, i) => `
          <tr>
            <td style="color:var(--text-tertiary)">${i + 1}</td>
            ${CSV_COLUMNS.map(c => `<td>${esc(r[c] || '—')}</td>`).join('')}
            <td>${r.error ? `<span class="badge badge-red">${esc(codeLabel(r.error))}</span>` : `<span class="badge badge-green">${esc(t('linux.import.valid'))}</span>`}</td>
            <td style="text-align:right"><button class="btn btn-sm" onclick="lxImpRemove(${i})"><i class="ti ti-x"></i></button></td>
          </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty-state" style="padding:1.5rem"><p>${esc(t('linux.import.preview_empty'))}</p></div>`}`
  }

  function paintResults() {
    const el = pane.querySelector('#lxi-results')
    if (!results) { el.style.display = 'none'; return }
    el.style.display = ''
    const ok = results.filter(r => r.ok).length
    el.innerHTML = `
      <div class="panel-header">${esc(t('linux.import.results', { ok, errors: results.length - ok }))}</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>${esc(t('linux.queue.serial'))}</th><th>${esc(t('linux.import.col.code'))}</th><th>${esc(t('linux.import.col.message'))}</th></tr></thead>
        <tbody>${results.map((r, k) => `
          <tr>
            <td style="color:var(--text-tertiary)">${k + 1}</td>
            <td style="font-family:var(--font-mono,monospace);font-size:11px">${esc(r.serial || '—')}</td>
            <td>${r.ok ? `<span class="badge badge-green">${esc(t('linux.import.valid'))}</span>` : `<span class="badge badge-red">${esc(r.code)}</span>`}</td>
            <td>${esc(r.ok ? t('linux.import.created') : (r.message || codeLabel(r.code)))}</td>
          </tr>`).join('')}</tbody></table></div>`
  }

  const addRows = rows => {
    pending.push(...rows.map(r => ({ ...r, error: validateImportRow(r) })))
    paintPreview()
  }
  pane.querySelector('#lxi-row-form').addEventListener('submit', event => {
    event.preventDefault()
    const form = event.target
    addRows([{
      serial: form.querySelector('#lxi-serial').value.trim(), hostname: form.querySelector('#lxi-hostname').value.trim().toLowerCase(),
      profile: form.querySelector('#lxi-profile').value.trim().toLowerCase(), ring: form.querySelector('#lxi-ring').value, email: form.querySelector('#lxi-email').value.trim(),
    }])
    form.reset()
    form.querySelector('#lxi-serial').focus()
  })
  window.lxImpParse = () => {
    const rows = parseImportCsv(pane.querySelector('#lxi-csv').value)
    if (!rows.length) { showToast(t('linux.import.csv_empty'), 'info'); return }
    addRows(rows)
    pane.querySelector('#lxi-csv').value = ''
  }
  window.lxImpRemove = i => { pending.splice(i, 1); paintPreview() }
  window.lxImpClear = () => { pending = []; results = null; paintPreview(); paintResults() }
  window.lxImpSubmit = async () => {
    const button = pane.querySelector('#lxi-submit')
    // Seules les lignes valides partent ; `sent[i]` = index dans l'aperçu
    // pour relier `errors[].id` (index du lot) à la ligne affichée.
    const sent = pending.map((r, i) => (r.error ? null : i)).filter(i => i !== null)
    if (!sent.length) return
    button.disabled = true
    try {
      const payload = sent.map(i => {
        const r = pending[i]
        const row = { serial: r.serial, profile: r.profile, ring: r.ring }
        if (r.hostname) row.hostname = r.hostname
        if (r.email) row.email = r.email
        return row
      })
      const result = await window.api.createLinuxPreregistrations(payload)
      const errors = new Map((result.errors || []).map(e => [Number(e.id), e]))
      results = sent.map((index, k) => {
        const e = errors.get(k)
        return { index, serial: pending[index].serial, ok: !e, code: e?.code, message: e?.message }
      })
      showToast(t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }), result.errors?.length ? 'info' : 'success')
      // Les lignes acceptées quittent l'aperçu ; les refusées restent pour correction.
      const failed = new Set(results.filter(r => !r.ok).map(r => r.index))
      pending = pending.filter((r, i) => r.error || failed.has(i))
      paintPreview()
      paintResults()
    } catch (err) {
      showToast(err.message || t('error.generic'), 'error')
      button.disabled = false
    }
  }
  _tabRefresh.import = () => { paintPreview(); paintResults() }
  paintPreview()
  paintResults()
}

// ─── Onglet En attente (file d'approbation, PR 2b) ──────────────────────────

function renderQueue(pane, setPending) {
  let rows = []
  const selected = new Set()
  let refreshVersion = 0
  pane.innerHTML = `
    <div class="bulk-bar" id="linux-bulk">
      <span class="bulk-count" id="linux-selected"></span>
      <div class="bulk-actions">
        <button class="btn" onclick="linuxApprove()">${esc(t('linux.queue.approve_selected'))}</button>
        <button class="btn btn-danger" onclick="linuxReject()">${esc(t('linux.queue.reject_selected'))}</button>
      </div>
    </div>
    <div class="table-wrap" id="linux-table"></div>`
  const table = pane.querySelector('#linux-table')

  function updateSelection() {
    pane.querySelector('#linux-bulk').classList.toggle('show', selected.size > 0)
    pane.querySelector('#linux-selected').textContent = t('linux.queue.selected', { n: selected.size })
    const all = pane.querySelector('#linux-all')
    if (all) {
      all.checked = rows.length > 0 && selected.size === rows.length
      all.indeterminate = selected.size > 0 && selected.size < rows.length
    }
    table.querySelectorAll('[data-enrollment]').forEach(cb => {
      cb.checked = selected.has(cb.dataset.enrollment)
      cb.closest('tr').classList.toggle('selected', cb.checked)
    })
  }

  async function refresh() {
    const version = ++refreshVersion
    table.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2"></i> ${esc(t('linux.queue.loading'))}</div>`
    selected.clear()
    updateSelection()
    try {
      // La file est plafonnée à 500 côté serveur ; charger toute la sélection.
      const [data, count] = await Promise.all([
        window.api.getLinuxEnrollments({ status: 'pending', limit: 500 }),
        window.api.getLinuxEnrollmentsCount(),
      ])
      if (!table.isConnected || version !== refreshVersion) return
      rows = data.rows
      setPending(count.pending)
      table.innerHTML = rows.length ? `
        <table><thead><tr>
          <th><input type="checkbox" id="linux-all" aria-label="${esc(t('linux.queue.select_all'))}" onchange="linuxSelectAll(this.checked)"></th>
          ${['code', 'serial', 'hostname_claimed', 'os', 'agent', 'first_seen', 'last_seen', 'conflict', 'actions'].map(k => `<th>${esc(t('linux.queue.' + k))}</th>`).join('')}
        </tr></thead><tbody>${rows.map(row => `
          <tr>
            <td><input type="checkbox" data-enrollment="${esc(row.id)}" aria-label="${esc(t('linux.queue.select', { code: row.code }))}" onchange="linuxSelect(${jsArg(row.id)},this.checked)"></td>
            <td><button class="btn btn-sm" style="font-family:var(--font-mono,monospace)" title="${esc(t('linux.queue.copy'))}" onclick="linuxCopy(${jsArg(row.code)})">${esc(row.code)} <i class="ti ti-copy"></i></button></td>
            <td>${esc(row.serial_claimed || '—')}</td><td>${esc(row.hostname_claimed || '—')}</td>
            <td>${esc(row.os_version || '—')}</td><td>${esc(row.agent_version || '—')}</td>
            <td>${esc(formatRelative(row.first_seen_at))}</td><td>${esc(formatRelative(row.last_seen_at))}</td>
            <td>${row.conflict ? `<span class="badge badge-orange">${esc(t('linux.queue.conflict.' + row.conflict.kind, { hostname: row.conflict.hostname || '—' }))}</span>` : ''}
                ${row.preregistration ? `<span class="badge badge-blue">${esc(t('linux.queue.preregistered'))}</span>` : ''}</td>
            <td><div style="display:flex;gap:6px"><button class="btn btn-sm btn-primary" onclick="linuxApprove(${jsArg(row.id)})">${esc(t('linux.queue.approve'))}</button>
                <button class="btn btn-sm" onclick="linuxReject(${jsArg(row.id)})">${esc(t('linux.queue.reject'))}</button></div></td>
          </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><i class="ti ti-check"></i><p>${esc(t('linux.queue.empty'))}</p></div>`
    } catch (err) {
      if (table.isConnected && version === refreshVersion) table.innerHTML = `<div class="empty-state"><p>${esc(err.message || t('error.generic'))}</p><button class="btn" onclick="linuxRefresh()">${esc(t('linux.queue.refresh'))}</button></div>`
    }
  }

  function openAction(id, approve) {
    const row = id ? rows.find(r => r.id === id) : null
    const ids = id ? [id] : [...selected]
    if (!ids.length || (id && !row)) return
    const bulk = !id
    const pre = row?.preregistration
    const conflict = row?.conflict
    let pickedUser = pre?.assigned_user || null
    const title = t('linux.queue.' + (approve ? (bulk ? 'approve_selected' : 'approve') : (bulk ? 'reject_selected' : 'reject')))
    showModal(`
      <form id="linux-action-form">
        <div class="modal-title">${esc(title)}${row ? ` · ${esc(row.code)}` : ''}</div>
        <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:12px">
          ${approve ? `
            <div class="form-row"><label class="form-label" for="linux-profile">${esc(t('linux.queue.profile'))}</label>
              <input class="form-input" id="linux-profile" list="linux-profiles" required maxlength="64" pattern="^[a-z0-9][a-z0-9\\-]{0,63}$" value="${esc(pre?.profile || '')}" title="${esc(t('linux.queue.profile_hint'))}">${profileDatalist('linux-profiles', pre?.profile)}</div>
            <div class="form-row"><label class="form-label" for="linux-ring">${esc(t('linux.queue.ring'))}</label>
              <select class="form-select" id="linux-ring"><option value="pilot">${esc(t('linux.queue.ring.pilot'))}</option><option value="stable" ${pre?.ring === 'stable' ? 'selected' : ''}>${esc(t('linux.queue.ring.stable'))}</option></select></div>
            ${bulk ? `<p class="modal-sub">${esc(t('linux.queue.bulk_conflicts'))}</p>` : `
              <div class="form-row"><label class="form-label" for="linux-hostname">${esc(t('linux.queue.hostname'))}</label>
                <input class="form-input" id="linux-hostname" maxlength="63" pattern="^[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?$" value="${esc(pre?.hostname || '')}"></div>
              <div class="form-row"><label class="form-label" for="linux-user">${esc(t('linux.queue.user'))}</label>
                <input class="form-input" id="linux-user" autocomplete="off" placeholder="${esc(t('tickets.requester.search'))}" value="${esc(pickedUser?.display_name || pickedUser?.email || '')}">
                <div id="linux-users" class="pick-list" style="display:none"></div></div>
              ${conflict ? `<p class="modal-sub">${esc(t('linux.queue.conflict.' + conflict.kind, { hostname: conflict.hostname || '—' }))}</p>` : ''}
              ${conflict?.kind === 'existing_device' ? `
                <label><input type="checkbox" role="switch" id="linux-convert"> ${esc(t('linux.queue.convert', { hostname: conflict.hostname || '—' }))}</label>
                ${conflict.has_active_token ? `<label><input type="checkbox" role="switch" id="linux-revoke"> ${esc(t('linux.queue.revoke_token'))}</label>` : ''}` : ''}
              ${conflict?.kind === 'reimage' ? `<label><input type="checkbox" role="switch" id="linux-supersede"> ${esc(t('linux.queue.supersede'))}</label>` : ''}
            `}
          ` : `
            <p>${esc(t('linux.queue.reject_confirm', { n: ids.length }))}</p>
            <div class="form-row"><label class="form-label" for="linux-reason">${esc(t('linux.queue.reason'))}</label><textarea class="form-textarea" id="linux-reason" maxlength="500"></textarea></div>
          `}
          <p id="linux-action-error" role="alert" style="color:var(--red);margin:0"></p>
          <div class="modal-footer"><button type="button" class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button><button type="submit" class="btn ${approve ? 'btn-primary' : 'btn-danger'}">${esc(title)}</button></div>
        </fieldset>
      </form>`)
    const form = document.getElementById('linux-action-form')
    const fieldset = form.querySelector('fieldset')
    const error = form.querySelector('#linux-action-error')
    const userInput = form.querySelector('#linux-user')
    // Même recherche / pick-list que le demandeur des tickets ; invalider le
    // choix dès qu'on retape pour ne jamais envoyer un utilisateur invisible.
    if (userInput) {
      bindUserPicker(userInput, form.querySelector('#linux-users'), 'linuxPickUser',
        user => { pickedUser = user; if (user) error.textContent = '' },
        message => { error.textContent = message })
    }
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (fieldset.disabled) return
      const body = bulk ? { ids } : {}
      if (approve) {
        body.profile = form.querySelector('#linux-profile').value
        body.ring = form.querySelector('#linux-ring').value
        if (!bulk) {
          if (userInput.value.trim() && !pickedUser) {
            error.textContent = t('linux.queue.pick_user')
            return
          }
          const hostname = form.querySelector('#linux-hostname').value.trim()
          if (hostname) body.hostname = hostname
          body.assigned_user_id = pickedUser?.entra_id || null
          if (form.querySelector('#linux-convert')?.checked) body.convert_device_id = conflict.device_id
          if (form.querySelector('#linux-revoke')?.checked) body.revoke_active_token = true
          if (form.querySelector('#linux-supersede')?.checked) body.supersede = true
        }
      } else {
        const reason = form.querySelector('#linux-reason').value.trim()
        if (reason) body.reason = reason
      }
      fieldset.disabled = true
      error.textContent = ''
      try {
        const result = approve
          ? await (bulk ? window.api.approveLinuxEnrollmentsBulk(body) : window.api.approveLinuxEnrollment(id, body))
          : await (bulk ? window.api.rejectLinuxEnrollmentsBulk(body) : window.api.rejectLinuxEnrollment(id, body))
        const failures = bulk ? result.errors : []
        if (form.isConnected) {
          if (failures.length) {
            // Conserver les erreurs par ligne (dont CONFLICT) après le refresh.
            showModal(`<div class="modal-title">${esc(t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }))}</div>
              <div class="pick-list">${failures.map(e => `<div class="pick-row"><div class="t">${esc(rows.find(r => r.id === e.id)?.code || e.id)} · ${esc(e.code)}</div><div class="s">${esc(e.message || t('linux.queue.bulk_error'))}</div></div>`).join('')}</div>
              <div class="modal-footer"><button class="btn" onclick="closeModal()">${esc(t('linux.queue.close'))}</button></div>`)
          } else {
            closeModal()
            showToast(bulk ? t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }) : t(approve ? 'linux.queue.approved' : 'linux.queue.rejected'), 'success')
          }
        }
        if (table.isConnected) await refresh()
      } catch (err) {
        // ApiError.message contient le champ API `error`, notamment en 409.
        error.textContent = err.message || t('error.generic')
        fieldset.disabled = false
      }
    })
  }

  _tabRefresh.queue = refresh
  window.linuxSelect = (id, checked) => { checked ? selected.add(id) : selected.delete(id); updateSelection() }
  window.linuxSelectAll = checked => { rows.forEach(r => checked ? selected.add(r.id) : selected.delete(r.id)); updateSelection() }
  window.linuxApprove = id => openAction(id, true)
  window.linuxReject = id => openAction(id, false)
  window.linuxCopy = async code => {
    try { await navigator.clipboard.writeText(code); showToast(t('linux.queue.copied'), 'success') }
    catch { showToast(t('linux.queue.copy_error'), 'error') }
  }
  refresh()
}
