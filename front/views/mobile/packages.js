// Vue mobile — Packages de déploiement
let _packages = []
const _mOutputs = new Map()

export async function renderPackages(el) {
  _packages = []

  el.innerHTML = `
    <div class="m-header big">
      <button class="m-icon-btn ghost" onclick="window.location.hash='#/menu'"><i class="ti ti-arrow-left"></i></button>
      <div class="m-head-text"><h1>${esc(t('mobile.nav.route.packages'))}</h1></div>
      <button class="m-icon-btn primary" onclick="mPkgOpenCreate()">
        <i class="ti ti-plus"></i>
      </button>
    </div>
    <div class="m-scroll-list" id="m-pkg-list" style="padding:12px;gap:10px">
      <div class="m-loading-row"><div class="m-spinner"></div></div>
    </div>`

  window.mPkgOpenCreate = mPkgOpenCreate
  window.mPkgSave       = mPkgSave
  window.mPkgApprove    = mPkgApprove
  window.mPkgDelete     = mPkgDelete
  window.mPkgOpenDeploy = mPkgOpenDeploy
  window.mPkgDeploy     = mPkgDeploy
  window.mPkgToggleType = mPkgToggleType
  window.mPkgCancelDep   = mPkgCancelDep
  window.mPkgRetryDep    = mPkgRetryDep
  window.mPkgShowOutput  = (id) => {
    const raw = _mOutputs.get(id) || ''
    const clean = raw.split(/\r\n|\r|\n/).filter(l => /[a-zA-Z0-9]/.test(l)).join('\n')
    window.mShowSheet(`
      <div class="m-sheet-title">${esc(t('mobile.packages.output'))}</div>
      <pre style="font-size:11px;background:var(--bg-tertiary);padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow-y:auto">${esc(clean)}</pre>
      <button class="m-btn-primary" style="margin-top:12px;background:var(--bg-secondary);color:var(--text-primary)" onclick="window.mCloseSheet()">${esc(t('btn.close'))}</button>`
    )
  }

  await loadPackages()
}

async function loadPackages() {
  const list = document.getElementById('m-pkg-list')
  try {
    _packages = await window.api.getPackages()
    renderList()
  } catch (err) {
    if (list) list.innerHTML = mErrorBox(err.message, () => loadPackages())
  }
}

function renderList() {
  const list = document.getElementById('m-pkg-list')
  if (!list) return
  if (!_packages.length) {
    list.innerHTML = `<div class="m-empty"><span>${esc(t('mobile.packages.empty'))}</span></div>`
    return
  }
  list.innerHTML = _packages.map(p => {
    const approved  = p.status === 'approved'
    const success   = parseInt(p.success_count) || 0
    const failed    = parseInt(p.failed_count)  || 0
    const pending   = (parseInt(p.pending_count) || 0) + (parseInt(p.running_count) || 0)
    const detected  = parseInt(p.detected_count) || 0
    return `
    <div class="m-panel" onclick="mPkgDetail('${p.id}')" style="cursor:pointer">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 14px">
        <div style="width:38px;height:38px;border-radius:10px;background:var(--${approved ? 'green' : 'amber'}-10,var(--bg-secondary));display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-${p.type === 'winget' ? 'brand-windows' : 'terminal-2'}" style="font-size:18px;color:var(--${approved ? 'green' : 'amber'})"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">
            ${p.type === 'winget' ? esc(p.winget_id || '—') : esc(t('mobile.packages.type_script'))}
            ${p.version ? ` · v${esc(p.version)}` : ''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="m-pill ${approved ? 'm-pill-on' : 'm-pill-off'}" style="font-size:10px">
            ${esc(t(approved ? 'mobile.packages.approved' : 'mobile.packages.draft'))}
          </div>
        </div>
      </div>
      ${(success || failed || pending || detected) ? `
      <div style="display:flex;gap:14px;padding:0 14px 12px;font-size:11px;color:var(--text-tertiary)">
        ${detected  ? `<span><i class="ti ti-eye"></i> ${esc(t('mobile.packages.detected', { n: detected }))}</span>` : ''}
        ${success   ? `<span style="color:var(--green)"><i class="ti ti-check"></i> ${success}</span>` : ''}
        ${failed    ? `<span style="color:var(--red)"><i class="ti ti-x"></i> ${failed}</span>` : ''}
        ${pending   ? `<span style="color:var(--amber)"><i class="ti ti-clock"></i> ${esc(t('mobile.packages.pending', { n: pending }))}</span>` : ''}
      </div>` : ''}
    </div>`
  }).join('')

  window.mPkgDetail = async (id) => {
    window.mShowSheet(`<div class="m-loading-row"><div class="m-spinner"></div></div>`)
    try {
      const pkg = await window.api.getPackage(id)
      renderDetailSheet(pkg)
    } catch (err) {
      window.showToast(err.message || t('mobile.common.error'), 'error')
    }
  }
}

function renderDetailSheet(p) {
  const approved = p.status === 'approved'
  const pendingDeps = p.deployments.filter(d => d.status === 'pending' || d.status === 'running')
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(p.name)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <span class="m-pill ${approved ? 'm-pill-on' : 'm-pill-off'}">${esc(t(approved ? 'mobile.packages.approved' : 'mobile.packages.draft'))}</span>
      <span class="m-pill m-pill-off">${p.type === 'winget' ? 'Winget' : esc(t('mobile.packages.type_script'))}</span>
      ${p.version ? `<span class="m-pill">v${esc(p.version)}</span>` : ''}
    </div>
    ${p.winget_id ? `<div style="font-size:12px;background:var(--bg-tertiary);padding:8px 10px;border-radius:8px;font-family:monospace;margin-bottom:14px">${esc(p.winget_id)}</div>` : ''}
    ${p.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 14px">${esc(p.description)}</p>` : ''}

    <!-- Stats -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div style="background:var(--bg-tertiary);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--green)">${p.deployments.filter(d=>d.status==='success').length}</div>
        <div style="font-size:10px;color:var(--text-tertiary)">${esc(t('mobile.packages.stats.success'))}</div>
      </div>
      <div style="background:var(--bg-tertiary);border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--red)">${p.deployments.filter(d=>d.status==='failed').length}</div>
        <div style="font-size:10px;color:var(--text-tertiary)">${esc(t('mobile.packages.stats.failed'))}</div>
      </div>
    </div>

    <!-- Actions -->
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
      ${!approved
        ? `<button class="m-btn-primary" onclick="mPkgApprove('${p.id}', ${jsArg(p.name)}, this)">
             <i class="ti ti-shield-check"></i> ${esc(t('mobile.packages.approve'))}
           </button>`
        : `<button class="m-btn-primary" onclick="mPkgOpenDeploy('${p.id}', ${jsArg(p.name)})">
             <i class="ti ti-rocket"></i> ${esc(t('mobile.packages.deploy'))}
           </button>`
      }
      <div style="display:flex;gap:8px">
        <button class="m-btn-primary" style="flex:1;background:var(--bg-secondary);color:var(--text-primary)" onclick="mPkgOpenEdit('${p.id}')">
          <i class="ti ti-pencil"></i> ${esc(t('btn.edit'))}
        </button>
        <button class="m-btn-primary" style="background:var(--red)" onclick="mPkgDelete('${p.id}', ${jsArg(p.name)}, this)">
          <i class="ti ti-trash"></i>
        </button>
      </div>
    </div>

    <!-- Déploiements récents -->
    ${p.deployments.length ? `
    <div style="font-size:12px;font-weight:600;margin-bottom:8px">${esc(t('mobile.packages.recent'))}</div>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto">
      ${p.deployments.slice(0, 20).map(d => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-tertiary);border-radius:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500">${esc(d.hostname)}</div>
          <div style="font-size:10px;color:var(--text-tertiary)">${formatRelative(d.completed_at || d.queued_at)}</div>
        </div>
        <span style="font-size:10px;font-weight:600;color:${depColor(d.status)}">${esc(depLabel(d.status))}</span>
        ${d.status === 'failed' || d.status === 'cancelled' ? `<button class="m-icon-btn" style="width:24px;height:24px" onclick="mPkgRetryDep('${d.id}',this)"><i class="ti ti-refresh" style="font-size:12px"></i></button>` : ''}
        ${d.status === 'pending' ? `<button class="m-icon-btn" style="width:24px;height:24px;color:var(--red)" onclick="mPkgCancelDep('${d.id}',this)"><i class="ti ti-x" style="font-size:12px"></i></button>` : ''}
      </div>
      ${d.output ? (() => { _mOutputs.set(d.id, d.output); return `<button onclick="mPkgShowOutput('${d.id}')" style="width:100%;text-align:left;padding:6px 10px;background:var(--bg-primary);border-radius:6px;font-size:10px;font-family:monospace;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:none;cursor:pointer">${esc(d.output.split(/\r\n|\r|\n/).find(l => /[a-zA-Z0-9]/.test(l)) || '')}…</button>` })() : ''}`).join('')}
    </div>` : ''}
  `)
}

// Statut connu → libellé traduit ; inconnu → la valeur brute (échappée par l'appelant).
function depLabel(status) {
  return ['pending', 'running', 'success', 'failed', 'cancelled'].includes(status) ? t('mobile.packages.status.' + status) : String(status || '')
}

function depColor(status) {
  return { pending: 'var(--amber)', running: 'var(--blue)', success: 'var(--green)', failed: 'var(--red)', cancelled: 'var(--text-tertiary)' }[status] || 'var(--text-tertiary)'
}

// ── Création / édition ────────────────────────────────────────────────────────
let _editId = null

function mPkgOpenCreate() {
  _editId = null
  showPkgForm(null)
}

window.mPkgOpenEdit = async (id) => {
  _editId = id
  const pkg = await window.api.getPackage(id).catch(() => null)
  showPkgForm(pkg)
}

function showPkgForm(p) {
  const type = p?.type || 'winget'
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t(p ? 'mobile.packages.form.edit_title' : 'mobile.packages.form.new_title'))}</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div>
        <div class="m-label">${esc(t('mobile.packages.form.name'))}</div>
        <input class="m-input" id="mf-name" value="${esc(p?.name || '')}" placeholder="Mozilla Firefox">
      </div>
      <div>
        <div class="m-label">${esc(t('mobile.packages.form.type'))}</div>
        <select class="m-input" id="mf-type" onchange="mPkgToggleType()">
          <option value="winget"${type==='winget'?' selected':''}>Winget</option>
          <option value="script"${type==='script'?' selected':''}>${esc(t('mobile.packages.form.type_script'))}</option>
        </select>
      </div>
      <div id="mf-winget-row" style="${type!=='winget'?'display:none':''}">
        <div class="m-label">${esc(t('mobile.packages.form.winget_id'))}</div>
        <input class="m-input" id="mf-winget" value="${esc(p?.winget_id || '')}" placeholder="Mozilla.Firefox">
      </div>
      <div id="mf-script-row" style="${type!=='script'?'display:none':''}">
        <div class="m-label">${esc(t('mobile.packages.form.install'))}</div>
        <textarea class="m-input" id="mf-install" rows="4" style="font-family:monospace;font-size:11px">${esc(p?.install_script || '')}</textarea>
      </div>
      <div>
        <div class="m-label">${esc(t('mobile.packages.form.version'))}</div>
        <input class="m-input" id="mf-ver" value="${esc(p?.version || '')}" placeholder="120.0">
      </div>
      <div>
        <div class="m-label">${esc(t('mobile.packages.form.post_install'))} <span style="color:var(--text-tertiary)">${esc(t('mobile.packages.form.optional'))}</span></div>
        <textarea class="m-input" id="mf-postinstall" rows="3" style="font-family:monospace;font-size:10px" placeholder="# PATH fix, config...">${esc(p?.post_install_script || '')}</textarea>
      </div>
      <div>
        <div class="m-label">${esc(t('mobile.packages.form.detect'))} <span style="color:var(--text-tertiary)">${esc(t('mobile.packages.form.optional'))}</span></div>
        <textarea class="m-input" id="mf-detect" rows="3" style="font-family:monospace;font-size:10px" placeholder="${esc(t('mobile.packages.form.detect_ph'))}">${esc(p?.detection_script || '')}</textarea>
      </div>
      <button class="m-btn-primary" onclick="mPkgSave(this)">
        ${esc(t(p ? 'btn.save' : 'btn.create'))}
      </button>
    </div>`)
}

function mPkgToggleType() {
  const t = document.getElementById('mf-type')?.value
  document.getElementById('mf-winget-row').style.display = t === 'winget' ? '' : 'none'
  document.getElementById('mf-script-row').style.display = t === 'script' ? '' : 'none'
}

async function mPkgSave(btn) {
  const body = {
    name:                document.getElementById('mf-name')?.value?.trim(),
    type:                document.getElementById('mf-type')?.value,
    winget_id:           document.getElementById('mf-winget')?.value?.trim() || null,
    install_script:      document.getElementById('mf-install')?.value?.trim() || null,
    version:             document.getElementById('mf-ver')?.value?.trim() || null,
    post_install_script: document.getElementById('mf-postinstall')?.value?.trim() || null,
    detection_script:    document.getElementById('mf-detect')?.value?.trim() || null,
  }
  if (!body.name) { window.showToast(t('mobile.packages.name_required'), 'error'); return }
  await withBusy(btn, async () => {
    try {
      if (_editId) {
        await window.api.updatePackage(_editId, body)
        window.showToast(t('mobile.packages.toast.updated'), 'success')
      } else {
        await window.api.createPackage(body)
        window.showToast(t('mobile.packages.toast.created'), 'success')
      }
      window.mCloseSheet()
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}

async function mPkgApprove(id, name, btn) {
  if (!confirm(t('mobile.packages.confirm.approve', { name }))) return
  await withBusy(btn, async () => {
    try {
      await window.api.approvePackage(id)
      window.showToast(t('mobile.packages.toast.approved'), 'success')
      window.mCloseSheet()
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}

async function mPkgDelete(id, name, btn) {
  if (!confirm(t('mobile.packages.confirm.delete', { name }))) return
  await withBusy(btn, async () => {
    try {
      await window.api.deletePackage(id)
      window.showToast(t('mobile.packages.toast.deleted'), 'success')
      window.mCloseSheet()
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}

// ── Déploiement ───────────────────────────────────────────────────────────────
let _deployPkgId = null
let _deployDevices = []

async function mPkgOpenDeploy(id, name) {
  _deployPkgId = id
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t('mobile.packages.deploy_title', { name }))}</div>
    <div class="m-loading-row"><div class="m-spinner"></div></div>`)
  try {
    const data = await window.api.getDevices({ limit: 200 })
    _deployDevices = data.devices || data || []
    const online = _deployDevices.filter(d => d.status !== 'offline')
    window.mShowSheet(`
      <div class="m-sheet-title">${esc(t('mobile.packages.deploy_title', { name }))}</div>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 12px">${esc(t('mobile.packages.online_count', { n: online.length, total: _deployDevices.length }))}</p>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="m-btn-primary" style="flex:1;font-size:12px;padding:8px" onclick="mPkgSelAll(true)">${esc(t('mobile.packages.select_all'))}</button>
        <button class="m-btn-primary" style="flex:1;font-size:12px;padding:8px;background:var(--bg-secondary);color:var(--text-primary)" onclick="mPkgSelAll(false)">${esc(t('mobile.packages.select_none'))}</button>
      </div>
      <div style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:14px">
        ${online.map(d => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-tertiary);border-radius:8px;cursor:pointer">
          <input type="checkbox" class="mpkg-cb" value="${d.id}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">${esc(d.hostname)}</div>
            ${d.ip_netbird ? `<div style="font-size:10px;color:var(--text-tertiary)">${esc(d.ip_netbird)}</div>` : ''}
          </div>
        </label>`).join('')}
      </div>
      <button class="m-btn-primary" onclick="mPkgDeploy(this)">
        <i class="ti ti-rocket"></i> ${esc(t('mobile.packages.deploy'))}
      </button>`)
  } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
}

window.mPkgSelAll = (checked) => {
  document.querySelectorAll('.mpkg-cb').forEach(cb => cb.checked = checked)
}

async function mPkgDeploy(btn, confirmed = false) {
  const ids = [...document.querySelectorAll('.mpkg-cb:checked')].map(cb => cb.value)
  if (!ids.length) { window.showToast(t('mobile.packages.select_one'), 'error'); return }
  await withBusy(btn, async () => {
    try {
      const result = await window.api.deployPackage(_deployPkgId, { device_ids: ids, confirmed })
      if (result?.requires_confirmation) {
        if (!confirm(t('mobile.packages.confirm.deploy', { n: result.count }))) return
        await mPkgDeploy(btn, true)
        return
      }
      window.mCloseSheet()
      window.showToast(t('mobile.packages.toast.queued', { n: result.queued }), 'success')
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}

async function mPkgCancelDep(depId, btn) {
  if (!confirm(t('mobile.packages.confirm.cancel'))) return
  await withBusy(btn, async () => {
    try {
      await window.api.cancelDeployment(depId)
      window.showToast(t('mobile.packages.toast.cancelled'), 'success')
      window.mCloseSheet()
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}

async function mPkgRetryDep(depId, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.retryDeployment(depId)
      window.showToast(t('mobile.packages.toast.requeued'), 'success')
      window.mCloseSheet()
      await loadPackages()
    } catch (err) { window.showToast(err.message || t('mobile.common.error'), 'error') }
  })
}
