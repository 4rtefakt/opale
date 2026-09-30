// Fiche d'un poste Linux géré par état désiré (`#/linux/<id>`) : identité,
// affectation (profil / ring / utilisateur), historique des applications,
// compte administrateur local (panneau LAPS partagé), clés de récupération
// LUKS (révélation avec motif), révocation et suppression.
import { lapsPanel, lapsViewPassword, lapsRequestRotation, promptRemoteReason } from '/views/laps-panel.js'
import { loadProfiles, profileDatalist, revisionBadge, applyPill, revokeReasonModal, shortSha, bindUserPicker } from '/views/linux.js'

const PAGE = 50
let _device = null

const keyStatusBadge = key => {
  const status = key?.status
  const cls = status === 'approved' ? 'badge-green' : status === 'revoked' ? 'badge-red' : 'badge-gray'
  return `<span class="badge ${cls}">${esc(status ? t('linux.device.key_status.' + status) : '—')}</span>`
}

export async function renderLinuxDevice(container, id) {
  _device = null
  _reports.status = ''
  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left" style="flex-direction:column;align-items:flex-start;gap:2px">
        <div class="page-kicker"><a href="#/linux" class="nav-link">← ${esc(t('nav.linux'))}</a></div>
        <div style="display:flex;align-items:center;gap:10px;min-width:0"><h1 class="page-title" id="lxdev-hostname">…</h1><span id="lxdev-status"></span></div>
      </div>
      <div class="topbar-actions">
        <a class="btn" href="#/postes/${esc(id)}"><i class="ti ti-device-laptop"></i> ${esc(t('linux.device.inventory'))}</a>
        <button class="btn" onclick="lxDevReload()"><i class="ti ti-refresh"></i> ${esc(t('linux.queue.refresh'))}</button>
      </div>
    </div>
    <div id="lxdev-body" class="page-body">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  const reload = async () => {
    _device = await window.api.getLinuxDevice(id)
    render()
  }
  window.lxDevReload = () => reload().catch(err => showToast(err.message || t('error.generic'), 'error'))
  // Panneau LAPS partagé (laps-panel.js) : handlers liés au poste courant.
  window.lapsViewPassword    = () => lapsViewPassword(_device)
  window.lapsRequestRotation = () => lapsRequestRotation(_device, reload)
  window.lxDevCopyFingerprint = async () => {
    try { await navigator.clipboard.writeText(_device.key.fingerprint); showToast(t('linux.device.fingerprint_copied'), 'success') }
    catch { showToast(t('linux.queue.copy_error'), 'error') }
  }
  window.lxDevRevokeKey = () => {
    if (!_device) return
    revokeReasonModal(1, async reason => {
      try {
        _device = await window.api.revokeLinuxDevice(_device.id, reason)
        render()
        showToast(t('linux.device.revoked'), 'success')
      } catch (err) { showToast(err.message || t('error.generic'), 'error') }
    })
  }
  window.lxDevDelete = async () => {
    if (!_device) return
    const n = (_device.recovery_keys || []).length
    const recoveryWarning = n > 0 ? '\n\n' + t('poste.delete.recovery_warning', { n }) : ''
    if (!confirm(t('poste.delete.confirm', { hostname: _device.hostname }) + recoveryWarning)) return
    try {
      await window.api.deleteDevice(_device.id)
      showToast(t('linux.device.deleted'), 'success')
      navigateTo('/linux')
    } catch (err) { showToast(err.message || t('error.generic'), 'error') }
  }

  await loadProfiles()
  try {
    await reload()
  } catch (err) {
    const body = document.getElementById('lxdev-body')
    if (body) body.innerHTML = `<div class="empty-state"><i class="ti ti-brand-debian"></i><p>${esc(err.message || t('error.generic'))}</p></div>`
  }
}

function render() {
  const d = _device
  const body = document.getElementById('lxdev-body')
  if (!body) return
  document.getElementById('lxdev-hostname').textContent = d.hostname
  document.getElementById('lxdev-status').innerHTML = `<span class="sdot ${d.online ? 'dot-on' : 'dot-off'}" style="display:inline-block;margin-right:6px" title="${esc(t('status.' + (d.online ? 'online' : 'offline')))}"></span>${keyStatusBadge(d.key)}`

  const user = d.assigned_user
  const userInner = user
    ? `<div class="k">${esc(t('poste.facts.user'))}</div><div class="v">${esc(user.display_name || user.email || user.entra_id)}</div><div class="s">${esc(user.email || '')}&nbsp;</div>`
    : `<div class="k">${esc(t('poste.facts.user'))}</div><div class="v dim">${esc(t('poste.facts.unassigned'))}</div><div class="s">&nbsp;</div>`
  const prop = (k, v, s = '&nbsp;', vClass = '') => `<div class="prop static"><div class="k">${esc(k)}</div><div class="v ${vClass}">${v}</div><div class="s">${s}</div></div>`
  const fp = d.key?.fingerprint
  body.innerHTML = `
    <div class="props">
      ${prop(t('linux.queue.serial'), esc(d.serial || '—'), d.converted_from_windows ? esc(t('linux.device.converted')) : '&nbsp;')}
      ${prop(t('linux.queue.os'), esc(d.os || '—'), esc(d.kernel || ''))}
      ${prop(t('linux.queue.agent'), esc(d.key?.agent_version || '—'), `${esc(t('poste.hw.last_seen'))} · ${esc(formatRelative(d.last_seen))}`, d.key?.agent_version ? '' : 'dim')}
      ${prop(t('linux.device.key'), fp ? `<code>${esc(fp.slice(0, 12))}</code> <button class="btn btn-sm" title="${esc(t('linux.device.copy_fingerprint'))}" onclick="lxDevCopyFingerprint()"><i class="ti ti-copy"></i></button>` : '—', d.key ? esc(t('linux.device.backing.' + d.key.key_backing)) : '&nbsp;')}
      ${prop(t('linux.queue.profile'), `${esc(d.profile || '—')}${d.profile_in_repo === false ? ` <span class="badge badge-orange" title="${esc(t('linux.list.profile_missing_hint'))}">${esc(t('linux.list.profile_missing'))}</span>` : ''}`, `${esc(t('linux.queue.ring'))} · ${d.ring ? esc(t('linux.queue.ring.' + d.ring)) : '—'}`)}
      ${prop(t('linux.device.revision_applied'), shortSha(d.last_revision_applied), `${esc(t('linux.device.last_successful'))} · ${d.last_successful_revision ? esc(d.last_successful_revision.slice(0, 7)) : '—'}`)}
      ${prop(t('linux.device.ring_tip'), `${shortSha(d.ring_tip)} ${revisionBadge(d)}`, `${applyPill(d.last_apply_status)} ${d.last_apply_at ? esc(formatRelative(d.last_apply_at)) : ''}`)}
      ${user ? `<a class="prop" href="#/users/${esc(user.entra_id)}">${userInner}</a>` : `<div class="prop static">${userInner}</div>`}
    </div>
    <div class="pd-grid">
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="panel">
          <div class="panel-header"><i class="ti ti-history"></i> ${esc(t('linux.device.reports.title'))}
            <select class="form-select" id="lxdev-report-status" style="width:auto;height:30px;font-size:12px;padding:0 8px;margin-left:auto" onchange="lxDevReportsFilter(this.value)">
              <option value="">${esc(t('linux.device.reports.all'))}</option>
              ${['success', 'failed', 'partial', 'skipped'].map(s => `<option value="${s}" ${_reports.status === s ? 'selected' : ''}>${esc(t('poste.pull.status.' + s))}</option>`).join('')}
            </select>
          </div>
          <div id="lxdev-reports"><div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div></div>
        </div>
        <div class="panel">
          <div class="panel-header"><i class="ti ti-lock"></i> ${esc(t('linux.device.keys.title'))}
            ${d.needs_escrow ? `<span class="badge badge-red" style="margin-left:auto">${esc(t('linux.list.escrow.missing'))}</span>` : ''}
          </div>
          <div id="lxdev-keys"><div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        ${assignmentPanel(d)}
        ${lapsPanel(d)}
        <div class="panel">
          <div class="panel-header" style="color:var(--red)"><i class="ti ti-alert-triangle"></i> ${esc(t('linux.device.danger.title'))}</div>
          <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
            <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('linux.device.danger.revoke_desc'))}</p>
            <button class="btn btn-sm btn-danger" onclick="lxDevRevokeKey()" ${d.key?.status === 'approved' ? '' : 'disabled'}><i class="ti ti-key-off"></i> ${esc(t('linux.device.danger.revoke'))}</button>
            ${d.key?.status === 'revoked' && d.key.revoked_at ? `<p style="font-size:11px;color:var(--text-tertiary);margin:0">${esc(t('linux.device.danger.revoked_at', { when: formatRelative(d.key.revoked_at), by: d.key.revoked_by || '—' }))}${d.key.revoke_reason ? ` · ${esc(d.key.revoke_reason)}` : ''}</p>` : ''}
            <p style="font-size:12px;color:var(--text-tertiary);margin:0">${esc(t('linux.device.danger.delete_desc'))}</p>
            <button class="btn btn-sm" style="color:var(--red)" onclick="lxDevDelete()"><i class="ti ti-trash"></i> ${esc(t('poste.action.delete'))}</button>
          </div>
        </div>
      </div>
    </div>`
  bindAssignment(d)
  loadReports(d.id, _reports.status)
  loadRecoveryKeys(d.id)
}

// ─── Affectation ────────────────────────────────────────────────────────────

function assignmentPanel(d) {
  const user = d.assigned_user
  return `
    <div class="panel">
      <div class="panel-header"><i class="ti ti-file-settings"></i> ${esc(t('linux.device.assign.title'))}</div>
      <form id="lxdev-assign" style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
        <div class="form-row"><label class="form-label" for="lxdev-profile">${esc(t('linux.queue.profile'))}</label>
          <input class="form-input" id="lxdev-profile" list="lxdev-profiles" required maxlength="64" pattern="^[a-z0-9][a-z0-9\\-]{0,63}$" value="${esc(d.profile || '')}" title="${esc(t('linux.queue.profile_hint'))}">${profileDatalist('lxdev-profiles', d.profile)}</div>
        <div class="form-row"><label class="form-label" for="lxdev-ring">${esc(t('linux.queue.ring'))}</label>
          <select class="form-select" id="lxdev-ring">${['pilot', 'stable'].map(r => `<option value="${r}" ${d.ring === r ? 'selected' : ''}>${esc(t('linux.queue.ring.' + r))}</option>`).join('')}</select></div>
        <div class="form-row"><label class="form-label" for="lxdev-user">${esc(t('poste.facts.user'))}</label>
          <div style="display:flex;gap:6px">
            <input class="form-input" id="lxdev-user" autocomplete="off" placeholder="${esc(t('tickets.requester.search'))}" value="${esc(user?.display_name || user?.email || '')}">
            <button type="button" class="btn btn-sm" title="${esc(t('linux.device.assign.unassign'))}" onclick="lxDevClearUser()"><i class="ti ti-x"></i></button>
          </div>
          <div id="lxdev-users" class="pick-list" style="display:none"></div></div>
        <p id="lxdev-assign-error" role="alert" style="color:var(--red);margin:0;font-size:12px"></p>
        <p style="font-size:11px;color:var(--text-tertiary);margin:0">${esc(t('linux.device.assign.hint'))}</p>
        <button type="submit" class="btn btn-primary btn-sm"><i class="ti ti-device-floppy"></i> ${esc(t('settings.btn.save'))}</button>
      </form>
    </div>`
}

// Même recherche / pick-list que la file d'approbation ; l'utilisateur choisi
// est invalidé dès qu'on retape pour ne jamais envoyer un nom non résolu.
function bindAssignment(d) {
  const form = document.getElementById('lxdev-assign')
  if (!form) return
  const userInput = form.querySelector('#lxdev-user')
  const list = form.querySelector('#lxdev-users')
  const error = form.querySelector('#lxdev-assign-error')
  let picked = d.assigned_user ? { entra_id: d.assigned_user.entra_id } : null
  const picker = bindUserPicker(userInput, list, 'lxDevPickUser',
    user => { picked = user; if (user) error.textContent = '' },
    message => { error.textContent = message })
  window.lxDevClearUser = picker.clear
  form.addEventListener('submit', async event => {
    event.preventDefault()
    error.textContent = ''
    if (userInput.value.trim() && !picked) { error.textContent = t('linux.queue.pick_user'); return }
    // Seuls les champs modifiés partent (PATCH minProperties: 1).
    const body = {}
    const profile = form.querySelector('#lxdev-profile').value.trim()
    const ring = form.querySelector('#lxdev-ring').value
    const userId = picked?.entra_id || null
    if (profile !== (d.profile || '')) body.profile = profile
    if (ring !== d.ring) body.ring = ring
    if (userId !== (d.assigned_user?.entra_id || null)) body.assigned_user_id = userId
    if (!Object.keys(body).length) { showToast(t('linux.device.assign.unchanged'), 'info'); return }
    const button = form.querySelector('button[type=submit]')
    button.disabled = true
    try {
      _device = await window.api.updateLinuxDevice(d.id, body)
      render()
      showToast(t('linux.device.assign.saved'), 'success')
    } catch (err) {
      error.textContent = err.message || t('error.generic')
      button.disabled = false
    }
  })
}

// ─── Historique d'application ───────────────────────────────────────────────

let _reports = { rows: [], total: 0, status: '', version: 0 }

async function loadReports(deviceId, status, append = false) {
  const el = document.getElementById('lxdev-reports')
  if (!el) return
  const version = ++_reports.version
  if (!append) { _reports.rows = []; _reports.status = status; el.innerHTML = `<div class="empty-state" style="padding:1rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>` }
  try {
    const page = await window.api.getLinuxDeviceReports(deviceId, { status: _reports.status, limit: PAGE, offset: append ? _reports.rows.length : 0 })
    if (!el.isConnected || version !== _reports.version) return
    _reports.rows = append ? [..._reports.rows, ...page.rows] : page.rows
    _reports.total = page.total
    paintReports()
  } catch (err) {
    if (el.isConnected && version === _reports.version) el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>${esc(err.message || t('error.generic'))}</p></div>`
  }
}

const duration = (a, b) => {
  if (!a || !b) return ''
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

function paintReports() {
  const el = document.getElementById('lxdev-reports')
  if (!el) return
  const { rows, total } = _reports
  if (!rows.length) { el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>${esc(t('linux.device.reports.empty'))}</p></div>`; return }
  el.innerHTML = rows.map((r, i) => {
    const rowId = `lxr-${i}`
    const hasDetail = !!(r.error_summary || r.log_tail)
    return `
      <div class="audit-row">
        <div class="audit-row-main" onclick="lxDevToggleReport('${rowId}')" style="cursor:${hasDetail ? 'pointer' : 'default'}">
          ${applyPill(r.status)}
          ${shortSha(r.revision)}
          <span class="audit-row-text" style="color:var(--text-secondary)">${esc(r.error_summary || '')}</span>
          <span class="audit-row-time" title="${esc(r.received_at || '')}">${esc(formatRelative(r.started_at || r.received_at))}${duration(r.started_at, r.finished_at) ? ` · ${esc(duration(r.started_at, r.finished_at))}` : ''}${r.agent_version ? ` · v${esc(r.agent_version)}` : ''}</span>
          ${hasDetail ? `<i class="ti ti-chevron-right audit-chevron" id="${rowId}-chevron"></i>` : ''}
        </div>
        ${hasDetail ? `<div class="audit-row-detail hidden" id="${rowId}-detail">
          ${r.error_summary ? `<div style="font-size:12px;margin-bottom:6px;word-break:break-word">${esc(r.error_summary)}</div>` : ''}
          ${r.log_tail ? `<pre>${esc(r.log_tail)}</pre>` : ''}
        </div>` : ''}
      </div>`
  }).join('') + (rows.length < total ? `<div style="display:flex;justify-content:center;padding:10px"><button class="btn btn-sm" onclick="lxDevReportsMore()">${esc(t('audit.load_more'))}</button></div>` : '')
}

window.lxDevReportsFilter = status => { if (_device) loadReports(_device.id, status) }
window.lxDevReportsMore = () => { if (_device) loadReports(_device.id, _reports.status, true) }
window.lxDevToggleReport = rowId => {
  const detail = document.getElementById(`${rowId}-detail`)
  const chevron = document.getElementById(`${rowId}-chevron`)
  if (!detail) return
  const isOpen = !detail.classList.contains('hidden')
  detail.classList.toggle('hidden', isOpen)
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)'
}

// ─── Clés de récupération ───────────────────────────────────────────────────

async function loadRecoveryKeys(deviceId) {
  const el = document.getElementById('lxdev-keys')
  if (!el) return
  try {
    const { rows } = await window.api.getLinuxRecoveryKeys(deviceId)
    if (!el.isConnected) return
    el.innerHTML = rows.length ? `
      <div class="table-wrap"><table><thead><tr>${['label', 'kind', 'created', 'current', 'last_viewed', 'actions'].map(k => `<th>${esc(t('linux.device.keys.col.' + k))}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(k => `
        <tr class="${k.current ? '' : 'tr-muted'}">
          <td style="font-family:var(--font-mono,monospace);font-size:11px">${esc(k.label)}</td>
          <td>${esc(t('linux.device.keys.kind.' + k.kind))}</td>
          <td style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${esc(formatRelative(k.created_at))}</td>
          <td>${k.current ? `<span class="badge badge-green">${esc(t('linux.device.keys.current'))}</span>` : `<span class="badge b-closed">${esc(k.superseded_at ? t('linux.device.keys.superseded') : t('linux.device.keys.other_key'))}</span>`}</td>
          <td style="font-size:11px;color:var(--text-tertiary)">${k.last_viewed_at ? `${esc(formatRelative(k.last_viewed_at))}${k.last_viewed_by_name ? ` · ${esc(k.last_viewed_by_name)}` : ''}` : '—'}</td>
          <td style="text-align:right"><button class="btn btn-sm" onclick="lxDevRevealKey(${jsArg(k.id)},${jsArg(k.label)})"><i class="ti ti-eye"></i> ${esc(t('remote.reason.reveal'))}</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty-state" style="padding:1rem"><p>${esc(t('linux.device.keys.empty'))}</p></div>`
  } catch (err) {
    if (el.isConnected) el.innerHTML = `<div class="empty-state" style="padding:1rem"><p>${esc(err.message || t('error.generic'))}</p></div>`
  }
}

// Révélation : motif (même modal que LAPS / SSH), puis secret injecté via DOM
// dans un champ masqué, copie, effacement automatique après 30 s.
window.lxDevRevealKey = async (kid, label) => {
  if (!_device) return
  const reason = await promptRemoteReason('recovery', _device.hostname)
  if (!reason) return
  try {
    const revealed = await window.api.revealLinuxRecoveryKey(_device.id, kid, reason)
    let remaining = 30
    showModal(`
      <div class="modal-title"><i class="ti ti-lock"></i> ${esc(t('linux.device.keys.reveal_title', { label }))}</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-row">
          <label class="form-label">${esc(t('linux.device.keys.secret'))}</label>
          <div style="display:flex;gap:8px">
            <input class="form-input" id="lxdev-secret" readonly type="password" style="font-family:monospace;letter-spacing:.1em;flex:1">
            <button class="btn btn-sm" onclick="window.lxDevToggleSecret()" title="${esc(t('linux.device.keys.show'))}"><i class="ti ti-eye"></i></button>
            <button class="btn btn-sm btn-primary" onclick="window.lxDevCopySecret()"><i class="ti ti-copy"></i> ${esc(t('linux.device.keys.copy'))}</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);text-align:center;background:var(--bg-secondary);border-radius:6px;padding:6px">
          ${esc(t('linux.device.keys.autoclose_prefix'))} <span id="lxdev-countdown">${remaining}</span> s
        </div>
      </div>
      <div class="modal-footer"><button class="btn" onclick="closeModal()">${esc(t('btn.close'))}</button></div>`)
    // Jamais dans l'HTML : le secret ne passe que par la valeur du champ.
    document.getElementById('lxdev-secret').value = revealed.secret
    window.lxDevToggleSecret = () => {
      const f = document.getElementById('lxdev-secret')
      if (f) f.type = f.type === 'password' ? 'text' : 'password'
    }
    window.lxDevCopySecret = () => {
      navigator.clipboard.writeText(revealed.secret).then(() => showToast(t('linux.device.keys.copied'), 'success'))
    }
    const iv = setInterval(() => {
      remaining--
      const el = document.getElementById('lxdev-countdown')
      if (el) el.textContent = remaining
      if (remaining <= 0 || !el) { clearInterval(iv); if (el) closeModal() }
    }, 1000)
    loadRecoveryKeys(_device.id)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}
