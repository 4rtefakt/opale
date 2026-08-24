// Vue Packages — bibliothèque de déploiement
let _packages = []
let _selected = null
const _outputs = new Map() // deployment_id → output brut

export async function renderPackages(container) {
  _packages = []
  _selected = null

  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">Packages</h1>
      <div class="topbar-actions">
        <button class="btn btn-primary btn-sm" onclick="pkgOpenCreate()">
          <i class="ti ti-plus"></i> ${t('packages.btn.new')}
        </button>
      </div>
    </div>
    <div style="display:flex;flex:1;overflow:hidden;gap:0">
      <!-- Liste -->
      <div id="pkg-list" style="width:380px;flex-shrink:0;border-right:0.5px solid var(--border);overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px">
        <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
      </div>
      <!-- Détail -->
      <div id="pkg-detail" style="flex:1;overflow-y:auto;padding:20px">
        <div class="empty-state" style="height:100%">
          <i class="ti ti-package" style="font-size:32px;color:var(--text-tertiary)"></i>
          <p style="color:var(--text-tertiary)">${t('packages.select_hint')}</p>
        </div>
      </div>
    </div>`

  window.pkgOpenCreate    = pkgOpenCreate
  window.pkgSave          = pkgSave
  window.pkgApprove       = pkgApprove
  window.pkgDelete        = pkgDelete
  window.pkgOpenDeploy    = pkgOpenDeploy
  window.pkgDeploy        = pkgDeploy
  window.pkgCancelDeploy  = pkgCancelDeploy
  window.pkgRetryDeploy   = pkgRetryDeploy
  window.pkgCancelJob     = pkgCancelJob
  window.pkgCancelAll     = pkgCancelAll
  window.pkgBulkRetry     = pkgBulkRetry
  window.pkgBulkCancel    = pkgBulkCancel
  window.pkgOpenEdit      = pkgOpenEdit
  window.pkgSelect        = pkgSelect

  await loadPackages()
}

async function loadPackages() {
  try {
    _packages = await window.api.getPackages()
    renderList()
    if (_selected) {
      const found = _packages.find(p => p.id === _selected.id)
      if (found) await pkgSelect(found.id)
    }
  } catch (err) {
    document.getElementById('pkg-list').innerHTML = `<div class="empty-state"><p style="color:var(--red)">${esc(err.message)}</p></div>`
  }
}

function renderList() {
  const list = document.getElementById('pkg-list')
  if (!list) return
  if (!_packages.length) {
    list.innerHTML = `<div class="empty-state" style="height:auto;padding:40px 0"><i class="ti ti-package" style="font-size:28px;color:var(--text-tertiary)"></i><p style="color:var(--text-tertiary)">${t('packages.empty')}</p></div>`
    return
  }
  list.innerHTML = _packages.map(p => {
    const isSelected = _selected?.id === p.id
    const badgeClass = p.status === 'approved' ? 'b-done' : 'b-open'
    const badgeTxt   = p.status === 'approved' ? t('packages.status.approved') : t('packages.status.draft')
    const success    = parseInt(p.success_count) || 0
    const failed     = parseInt(p.failed_count)  || 0
    const pending    = parseInt(p.pending_count) + parseInt(p.running_count) || 0
    return `
    <div class="audit-row" style="cursor:pointer;border-radius:var(--radius-md);padding:10px 12px;${isSelected ? 'background:var(--blue-10);border:1.5px solid var(--blue)' : 'border:1px solid var(--border)'}"
         onclick="pkgSelect('${p.id}')">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-${p.type === 'winget' ? 'brand-windows' : 'terminal-2'}" style="font-size:20px;color:var(--text-secondary);flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">${p.type === 'winget' ? esc(p.winget_id || '—') : t('packages.type.custom_script')}</div>
        </div>
        <span class="badge ${badgeClass}" style="font-size:10px;padding:2px 7px">${badgeTxt}</span>
      </div>
      ${(success || failed || pending) ? `
      <div style="display:flex;gap:8px;margin-top:8px;font-size:11px">
        ${pending ? `<span style="color:var(--amber)"><i class="ti ti-clock"></i> ${pending}</span>` : ''}
        ${success ? `<span style="color:var(--green)"><i class="ti ti-check"></i> ${success}</span>` : ''}
        ${failed  ? `<span style="color:var(--red)"><i class="ti ti-x"></i> ${failed}</span>`  : ''}
      </div>` : ''}
    </div>`
  }).join('')
}

async function pkgSelect(id) {
  const detail = document.getElementById('pkg-detail')
  detail.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>`
  try {
    _selected = await window.api.getPackage(id)
    renderList() // mettre à jour la sélection dans la liste
    renderDetail()
  } catch (err) {
    detail.innerHTML = `<div class="empty-state"><p style="color:var(--red)">${esc(err.message)}</p></div>`
  }
}

function renderDetail() {
  const p      = _selected
  const detail = document.getElementById('pkg-detail')
  if (!p || !detail) return

  // Counts agrégés côté serveur (sur TOUS les deployments, pas seulement
  // les 50 derniers servis dans p.deployments). Les filter() locaux étaient
  // faux pour les packages avec > 50 déploiements.
  const c = p.counts || { pending: 0, running: 0, success: 0, failed: 0, detected: 0 }
  const pendingDepsCount = c.pending + c.running
  const doneCount        = c.success
  const failCount        = c.failed
  const detectedCount    = c.detected
  // pendingDeps utilisé plus bas pour la table — on garde la liste des 50
  const pendingDeps = p.deployments.filter(d => d.status === 'pending' || d.status === 'running')

  detail.innerHTML = `
    <div style="max-width:860px">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:20px">
        <i class="ti ti-${p.type === 'winget' ? 'brand-windows' : 'terminal-2'}" style="font-size:28px;color:var(--text-secondary);margin-top:3px"></i>
        <div style="flex:1">
          <h2 style="font-size:17px;font-weight:700;margin:0">${esc(p.name)}</h2>
          ${p.description ? `<p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0">${esc(p.description)}</p>` : ''}
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
            <span class="badge ${p.status === 'approved' ? 'b-done' : 'b-open'}">${p.status === 'approved' ? t('packages.status.approved') : t('packages.status.draft')}</span>
            <span class="badge b-closed">${p.type === 'winget' ? 'Winget' : t('packages.type.script')}</span>
            ${p.version ? `<span style="font-size:11px;color:var(--text-tertiary)">v${esc(p.version)}</span>` : ''}
            ${p.winget_id ? `<code style="font-size:11px;background:var(--bg-secondary);padding:2px 6px;border-radius:4px">${esc(p.winget_id)}</code>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm" onclick="pkgOpenEdit()"><i class="ti ti-pencil"></i> ${t('packages.btn.edit')}</button>
          ${p.status !== 'approved'
            ? `<button class="btn btn-sm btn-primary" onclick="pkgApprove()"><i class="ti ti-shield-check"></i> ${t('packages.btn.approve')}</button>`
            : `<button class="btn btn-sm btn-primary" onclick="pkgOpenDeploy()"><i class="ti ti-rocket"></i> ${t('packages.btn.deploy')}</button>`
          }
          ${(pendingDepsCount > 0 || (p.active_jobs || []).length > 0)
            ? `<button class="btn btn-sm" style="color:var(--red)" onclick="pkgCancelAll()" title="${t('packages.btn.cancel_all_title')}"><i class="ti ti-player-stop"></i> ${t('packages.btn.cancel_all')}</button>`
            : ''
          }
          <button class="btn btn-sm" style="color:var(--red)" onclick="pkgDelete()"><i class="ti ti-trash"></i></button>
        </div>
      </div>

      <!-- Stats -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        ${statCard(t('packages.stat.detected'), detectedCount, 'ti-eye', 'var(--blue)')}
        ${statCard(t('packages.stat.success'), doneCount, 'ti-check', 'var(--green)')}
        ${statCard(t('packages.stat.failed'), failCount, 'ti-x', 'var(--red)')}
        ${statCard(t('packages.stat.pending'), pendingDepsCount, 'ti-clock', 'var(--amber)')}
      </div>

      ${p.approved_by_name ? `<p style="font-size:11px;color:var(--text-tertiary);margin-bottom:16px">${t('packages.approved_by', { name: esc(p.approved_by_name), date: formatWithDate(p.approved_at) })}</p>` : ''}

      ${(p.active_jobs || []).length ? `
      <!-- Déploiements automatiques actifs (scope=all|group|user) — perpétuels -->
      <h3 style="font-size:13px;font-weight:600;margin:0 0 8px">${t('packages.auto.title')}</h3>
      <p style="font-size:11px;color:var(--text-tertiary);margin:0 0 8px">
        ${t('packages.auto.hint')}
      </p>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
        ${p.active_jobs.map(j => {
          const icon  = j.scope === 'all'          ? 'ti-world'
                      : j.scope === 'user'         ? 'ti-user'
                      : j.scope === 'native_group' ? 'ti-circles'
                      : 'ti-users-group'
          const label = j.scope === 'all'          ? t('packages.scope.all_managed')
                      : j.scope === 'user'         ? t('packages.auto.user_label', { user: j.target_user_name ? `<strong>${esc(j.target_user_name)}</strong>` : `<code style="font-size:11px">${esc(j.user_entra_id)}</code>` })
                      : j.scope === 'native_group' ? t('packages.auto.native_group_label', { group: `<code style="font-size:11px">${esc(j.native_group_id)}</code>` })
                      : t('packages.auto.entra_group_label', { group: `<code style="font-size:11px">${esc(j.source_group_id)}</code>` })
          return `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.3);border-radius:6px;font-size:12px">
            <i class="ti ${icon}" style="color:var(--green)"></i>
            <span style="flex:1">
              ${label}
              ${j.deployed_by_name ? ` · ${t('packages.auto.by', { name: esc(j.deployed_by_name) })}` : ''}
              · ${t('packages.auto.activated', { when: formatRelative(j.created_at) })}
            </span>
            <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="pkgCancelJob('${esc(j.id)}')" title="${t('packages.auto.stop_title')}">
              <i class="ti ti-player-stop"></i> ${t('packages.btn.stop')}
            </button>
          </div>`
        }).join('')}
      </div>` : ''}

      <!-- Déploiements récents -->
      <h3 style="font-size:13px;font-weight:600;margin:0 0 10px">
        ${t('packages.recent.title')}
        ${c.total_rows > p.deployments.length
          ? `<span style="font-size:11px;font-weight:400;color:var(--text-tertiary);margin-left:8px">${t('packages.recent.showing', { shown: p.deployments.length, total: c.total_rows })}${c.unique_devices !== c.total_rows ? ` ${t('packages.recent.unique_devices', { n: c.unique_devices })}` : ''}</span>`
          : ''}
      </h3>
      ${p.deployments.length ? `
      <!-- Barre d'actions bulk (visible quand sélection non vide) -->
      <div id="pkg-bulk-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 12px;background:var(--bg-secondary);border:0.5px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
        <span id="pkg-bulk-count" style="font-weight:500">${t('packages.selected_count', { n: 0 })}</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="pkgDepSelectByStatus('failed')" title="${t('packages.bulk.select_failed_title')}">${t('packages.bulk.select_failed')}</button>
        <button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="pkgDepSelectByStatus('pending')" title="${t('packages.bulk.select_pending_title')}">${t('packages.bulk.select_pending')}</button>
        <button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="pkgDepSelectNone()">${t('packages.bulk.select_none')}</button>
        <button class="btn btn-sm" id="pkg-bulk-retry"  onclick="pkgBulkRetry()"  disabled><i class="ti ti-refresh"></i> ${t('packages.btn.retry')}</button>
        <button class="btn btn-sm" id="pkg-bulk-cancel" onclick="pkgBulkCancel()" disabled><i class="ti ti-x"></i> ${t('btn.cancel')}</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="pkg-dep-cb-all" onchange="pkgDepSelectAll(this.checked)"></th>
          <th>${t('packages.col.device')}</th><th>${t('packages.col.assigned')}</th><th>${t('packages.col.status')}</th><th>${t('packages.col.code')}</th><th>${t('packages.col.deployed_by')}</th><th>${t('packages.col.finished')}</th><th style="width:90px"></th>
        </tr></thead>
        <tbody>
          ${[...p.deployments].sort((a, b) => {
            // Tri par statut : running → failed → success → reste (pending,
            // cancelled). Met en avant ce qui demande de l'attention
            // (running = en cours, à surveiller ; failed = à rejouer).
            // Au sein d'un statut, plus récent en premier (created_at desc).
            const rank = s => s === 'running' ? 0
                            : s === 'failed'  ? 1
                            : s === 'success' ? 2
                            : 3
            const dr = rank(a.status) - rank(b.status)
            if (dr !== 0) return dr
            return new Date(b.created_at || 0) - new Date(a.created_at || 0)
          }).map(d => {
            // Nom utilisateur assigné : on préfère le nom du cache users
            // (résolu via assigned_user_id → Entra). Si absent, fallback
            // sur la donnée Intune brute (intune_user_display_name).
            const assignedName = d.assigned_user_name || d.intune_user_display_name || ''
            // Selectable : seul ce qui est actionnable en bulk peut être
            // coché (pending = annulable ; failed/cancelled = rejouable).
            // running et success sont en lecture seule côté bulk.
            const selectable = ['pending','failed','cancelled'].includes(d.status)
            // Output success : caché par défaut (n'a pas d'info utile
            // pour un install qui s'est bien passé). On expose juste un
            // petit bouton dans la colonne actions pour voir si besoin.
            const showOutputInline = d.output && d.status !== 'success'
            const hasOutput        = !!d.output
            if (hasOutput) _outputs.set(d.id, d.output)
            return `
          <tr>
            <td>${selectable
              ? `<input type="checkbox" class="pkg-dep-cb" data-id="${d.id}" data-status="${d.status}" onchange="pkgUpdateBulkBar()">`
              : ''}</td>
            <td style="font-weight:500">${esc(d.hostname)}</td>
            <td style="color:var(--text-tertiary);font-size:11px">${assignedName ? esc(assignedName) : '—'}</td>
            <td><span class="badge ${depBadge(d.status)}">${esc(d.status)}</span></td>
            <td style="font-family:monospace">${d.exit_code ?? '—'}</td>
            <td style="color:var(--text-tertiary)">${d.deployed_by_name ? esc(d.deployed_by_name) : '—'}</td>
            <td style="color:var(--text-tertiary)">${d.completed_at ? formatRelative(d.completed_at) : '—'}</td>
            <td style="white-space:nowrap">
              ${d.status === 'success' && hasOutput ? `<button class="btn btn-sm" onclick="pkgShowOutput('${d.id}')" title="${t('packages.dep.view_output_title')}"><i class="ti ti-file-text"></i></button>` : ''}
              ${d.status === 'pending'  ? `<button class="btn btn-sm" onclick="pkgCancelDeploy('${d.id}')" title="${t('btn.cancel')}"><i class="ti ti-x"></i></button>` : ''}
              ${d.status === 'failed' || d.status === 'cancelled' ? `<button class="btn btn-sm" onclick="pkgRetryDeploy('${d.id}')" title="${t('packages.btn.retry')}"><i class="ti ti-refresh"></i></button>` : ''}
            </td>
          </tr>
          ${showOutputInline ? (() => {
            const firstLine = d.output.split(/\r\n|\r|\n/).find(l => /[a-zA-Z0-9]/.test(l)) || ''
            return `<tr><td colspan="8" style="padding:0 8px 8px">
              <button class="btn btn-sm" style="font-size:10px;font-family:monospace;text-align:left;width:100%;justify-content:flex-start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-tertiary)" onclick="pkgShowOutput('${d.id}')">${esc(firstLine)}&hellip;</button>
            </td></tr>`
          })() : ''}
          `}).join('')}
        </tbody>
      </table>` : `<p style="font-size:13px;color:var(--text-tertiary)">${t('packages.dep.empty')}</p>`}
    </div>`
}

function statCard(label, value, icon, color) {
  return `
  <div style="background:var(--bg-secondary);border:0.5px solid var(--border);border-radius:var(--radius-md);padding:12px 14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <i class="ti ${icon}" style="color:${color};font-size:14px"></i>
      <span style="font-size:11px;color:var(--text-tertiary)">${label}</span>
    </div>
    <div style="font-size:22px;font-weight:700">${value}</div>
  </div>`
}

function depBadge(status) {
  return { pending: 'b-open', running: 'b-prog', success: 'b-done', failed: 'b-closed', cancelled: 'b-closed' }[status] || 'b-closed'
}

// ── Formulaire création/édition ───────────────────────────────────────────────
function pkgOpenCreate() {
  showModal(`
    <div style="padding:20px;min-width:520px">
      <h3 style="margin:0 0 16px;font-size:15px">${t('packages.new.title')}</h3>
      ${pkgForm(null)}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-sm" onclick="closeModal()">${t('btn.cancel')}</button>
        <button class="btn btn-sm btn-primary" onclick="pkgSave(null)">${t('btn.create')}</button>
      </div>
    </div>`)
}

function pkgOpenEdit() {
  if (!_selected) return
  showModal(`
    <div style="padding:20px;min-width:520px">
      <h3 style="margin:0 0 16px;font-size:15px">${t('packages.edit.title', { name: esc(_selected.name) })}</h3>
      ${pkgForm(_selected)}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-sm" onclick="closeModal()">${t('btn.cancel')}</button>
        <button class="btn btn-sm btn-primary" onclick="pkgSave('${_selected.id}')">${t('packages.btn.save')}</button>
      </div>
    </div>`)
}

function pkgForm(p) {
  const type = p?.type || 'winget'
  return `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label class="form-label">${t('packages.form.name')}</label>
        <input class="form-input" id="pkg-name" value="${esc(p?.name || '')}" placeholder="Mozilla Firefox">
      </div>
      <div>
        <label class="form-label">${t('packages.form.description')}</label>
        <input class="form-input" id="pkg-desc" value="${esc(p?.description || '')}" placeholder="${t('packages.form.desc_placeholder')}">
      </div>
      <div>
        <label class="form-label">${t('packages.form.version')} <span style="color:var(--text-tertiary)">${t('packages.form.version_hint')}</span></label>
        <input class="form-input" id="pkg-ver" value="${esc(p?.version || '')}" placeholder="120.0">
      </div>
      <div>
        <label class="form-label">${t('packages.form.type')}</label>
        <select class="form-input" id="pkg-type" onchange="pkgToggleType()">
          <option value="winget"${type === 'winget' ? ' selected' : ''}>Winget</option>
          <option value="script"${type === 'script' ? ' selected' : ''}>${t('packages.form.type_script')}</option>
        </select>
      </div>
      <div id="pkg-winget-field" style="${type !== 'winget' ? 'display:none' : ''}">
        <label class="form-label">Winget ID <span style="color:var(--text-tertiary)">${t('packages.form.winget_hint')}</span></label>
        <div style="position:relative">
          <input class="form-input" id="pkg-winget" value="${esc(p?.winget_id || '')}" placeholder="${t('packages.form.winget_placeholder')}"
                 autocomplete="off" oninput="pkgWingetSearch(this.value)" onfocus="pkgWingetSearch(this.value)" onblur="pkgWingetBlur()">
          <div id="pkg-winget-results" style="position:absolute;top:100%;left:0;right:0;background:var(--bg-primary);border:0.5px solid var(--border);border-radius:0 0 var(--radius) var(--radius);box-shadow:0 4px 12px rgba(0,0,0,.25);max-height:240px;overflow-y:auto;z-index:100;display:none"></div>
        </div>
      </div>
      <div id="pkg-script-field" style="${type !== 'script' ? 'display:none' : ''}">
        <label class="form-label">${t('packages.form.install_script')}</label>
        <textarea class="form-input" id="pkg-install" rows="5" style="font-family:monospace;font-size:11px">${esc(p?.install_script || '')}</textarea>
      </div>
      <div>
        <label class="form-label">${t('packages.form.postinstall')} <span style="color:var(--text-tertiary)">${t('packages.form.postinstall_hint')}</span></label>
        <textarea class="form-input" id="pkg-postinstall" rows="3" style="font-family:monospace;font-size:11px" placeholder="${t('packages.form.postinstall_placeholder')}">${esc(p?.post_install_script || '')}</textarea>
      </div>
      <div>
        <label class="form-label">${t('packages.form.detect')} <span style="color:var(--text-tertiary)">${t('packages.form.detect_hint')}</span></label>
        <textarea class="form-input" id="pkg-detect" rows="3" style="font-family:monospace;font-size:11px" placeholder="if (Get-Command firefox -ea SilentlyContinue) { exit 0 } else { exit 1 }">${esc(p?.detection_script || '')}</textarea>
      </div>
    </div>`
}

window.pkgToggleType = () => {
  const t = document.getElementById('pkg-type')?.value
  document.getElementById('pkg-winget-field').style.display = t === 'winget' ? '' : 'none'
  document.getElementById('pkg-script-field').style.display = t === 'script' ? '' : 'none'
}

// Autocomplétion winget : interroge l'index officiel MS via notre API,
// debounce 250ms pour ne pas spammer à chaque frappe. Min 2 caractères.
let _wingetSearchTimer = null
let _wingetSearchSeq = 0  // anti-race : ignore les réponses tardives d'une recherche obsolète
window.pkgWingetSearch = (q) => {
  clearTimeout(_wingetSearchTimer)
  const results = document.getElementById('pkg-winget-results')
  if (!results) return
  const trimmed = (q || '').trim()
  if (trimmed.length < 2) { results.style.display = 'none'; results.innerHTML = ''; return }
  const seq = ++_wingetSearchSeq
  _wingetSearchTimer = setTimeout(async () => {
    try {
      const data = await window.api.searchWinget(trimmed, 20)
      if (seq !== _wingetSearchSeq) return  // réponse obsolète, on l'oublie
      if (!data.ready) {
        results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-tertiary)"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> ${t('packages.winget.loading')}</div>`
      } else if (!data.results.length) {
        results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-tertiary)">${t('packages.winget.no_results')}</div>`
      } else {
        results.innerHTML = data.results.map(r => `
          <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:0.5px solid var(--border)"
               onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''"
               onmousedown="event.preventDefault(); pkgWingetPick(${jsArg(r.package_id)}, ${jsArg(r.display_name || '')}, ${jsArg(r.version || '')})">
            <div style="font-weight:500;font-family:monospace;font-size:12px">${esc(r.package_id)}</div>
            <div style="color:var(--text-tertiary);font-size:11px;margin-top:2px">${esc(r.display_name || '')}${r.version ? ' · v' + esc(r.version) : ''}</div>
          </div>`).join('')
      }
      results.style.display = 'block'
    } catch (err) {
      if (seq !== _wingetSearchSeq) return
      results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--red)">${esc(err.message || t('error.generic'))}</div>`
      results.style.display = 'block'
    }
  }, 250)
}

// Sélection d'un résultat winget : remplit l'ID + pré-remplit nom/version
// si ces champs sont encore vides (on n'écrase pas ce que l'utilisateur a
// pu saisir lui-même).
window.pkgWingetPick = (id, name, version) => {
  const idInput = document.getElementById('pkg-winget')
  const nameInput = document.getElementById('pkg-name')
  const verInput = document.getElementById('pkg-ver')
  if (idInput)   idInput.value = id
  if (nameInput && !nameInput.value.trim() && name) nameInput.value = name
  if (verInput  && !verInput.value.trim()  && version) verInput.value = version
  const results = document.getElementById('pkg-winget-results')
  if (results) { results.style.display = 'none'; results.innerHTML = '' }
}

// Ferme le dropdown au blur, avec un léger délai pour laisser le mousedown
// du résultat se propager d'abord (sinon le clic est perdu).
window.pkgWingetBlur = () => {
  setTimeout(() => {
    const results = document.getElementById('pkg-winget-results')
    if (results) results.style.display = 'none'
  }, 150)
}

async function pkgSave(id) {
  const body = {
    name:             document.getElementById('pkg-name')?.value?.trim(),
    description:      document.getElementById('pkg-desc')?.value?.trim() || null,
    version:          document.getElementById('pkg-ver')?.value?.trim() || null,
    type:             document.getElementById('pkg-type')?.value,
    winget_id:        document.getElementById('pkg-winget')?.value?.trim() || null,
    install_script:       document.getElementById('pkg-install')?.value?.trim() || null,
    post_install_script:  document.getElementById('pkg-postinstall')?.value?.trim() || null,
    detection_script:     document.getElementById('pkg-detect')?.value?.trim() || null,
  }
  if (!body.name) { showToast(t('packages.form.name_required'), 'error'); return }
  try {
    if (id) {
      await window.api.updatePackage(id, body)
      showToast(t('packages.toast.updated'), 'success')
    } else {
      const pkg = await window.api.createPackage(body)
      showToast(t('packages.toast.created'), 'success')
      _selected = pkg
    }
    closeModal()
    await loadPackages()
    if (_selected) await pkgSelect(_selected.id)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function pkgApprove() {
  if (!_selected) return
  if (!confirm(t('packages.confirm.approve', { name: _selected.name }))) return
  try {
    await window.api.approvePackage(_selected.id)
    showToast(t('packages.toast.approved'), 'success')
    await loadPackages()
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function pkgDelete() {
  if (!_selected) return
  if (!confirm(t('packages.confirm.delete', { name: _selected.name }))) return
  try {
    await window.api.deletePackage(_selected.id)
    showToast(t('packages.toast.deleted'), 'success')
    _selected = null
    await loadPackages()
    document.getElementById('pkg-detail').innerHTML = `
      <div class="empty-state" style="height:100%">
        <i class="ti ti-package" style="font-size:32px;color:var(--text-tertiary)"></i>
        <p style="color:var(--text-tertiary)">${t('packages.select_hint')}</p>
      </div>`
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

// ── Déploiement ───────────────────────────────────────────────────────────────
let _devices = []
let _deployScope = 'device'      // 'device' | 'group' | 'native_group' | 'all' | 'user'
let _selectedGroup       = null  // { id, displayName }
let _selectedUser        = null  // { entra_id, display_name, email }
let _selectedNativeGroup = null  // { id, name, color }
let _nativeGroups        = []    // cache pour le select
let _groupSearchTimer = null
let _userSearchTimer  = null

async function pkgOpenDeploy() {
  if (!_selected) return
  _deployScope = 'device'
  _selectedGroup       = null
  _selectedUser        = null
  _selectedNativeGroup = null
  showModal(`<div style="padding:20px;min-width:580px"><div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div></div>`)
  try {
    const data = await window.api.getDevices({ limit: 200 })
    _devices = data.devices || data || []
    renderDeployModal()
  } catch (err) {
    showModal(`<div style="padding:20px"><p style="color:var(--red)">${esc(err.message)}</p></div>`)
  }
}

function renderDeployModal() {
  const online = _devices.filter(d => d.status !== 'offline')
  showModal(`
    <div style="padding:20px;min-width:580px">
      <h3 style="margin:0 0 4px;font-size:15px">${t('packages.deploy.title', { name: esc(_selected?.name) })}</h3>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 14px">${t('packages.deploy.device_stats', { total: _devices.length, online: online.length })}</p>

      <!-- Scope tabs -->
      <div style="display:flex;gap:2px;background:var(--bg-secondary);border-radius:var(--radius-md);padding:3px;margin-bottom:14px">
        ${[
          ['device',t('packages.scope.device'),'ti-devices','inventory'],
          ['user',t('packages.scope.user'),'ti-user','core'],
          ['native_group',t('packages.scope.native_group'),'ti-circles','groups'],
          ['group',t('packages.scope.group'),'ti-users-group','groups'],
          ['all',t('packages.scope.all'),'ti-world','inventory'],
        ].filter(([,,,mod]) => window.OPALE.moduleEnabled(mod)).map(([s,label,icon]) => `
          <button id="pkg-scope-btn-${s}" class="btn btn-sm${_deployScope===s?' btn-primary':''}"
            style="flex:1;justify-content:center;gap:5px"
            onclick="pkgSetScope('${s}')">
            <i class="ti ${icon}" style="font-size:13px"></i> ${label}
          </button>`).join('')}
      </div>

      <!-- Scope: device -->
      <div id="pkg-scope-device" style="${_deployScope!=='device'?'display:none':''}">
        <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" onclick="pkgSelectAll(true)">${t('packages.deploy.select_all')}</button>
          <button class="btn btn-sm" onclick="pkgSelectAll(false)">${t('packages.deploy.deselect_all')}</button>
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-left:8px">
            <input type="checkbox" id="pkg-online-only" onchange="pkgFilterOnline()" checked> ${t('packages.deploy.online_only')}
          </label>
        </div>
        <div id="pkg-dev-list" style="max-height:260px;overflow-y:auto;border:0.5px solid var(--border);border-radius:var(--radius);padding:4px">
          ${renderDeviceCheckboxes(online)}
        </div>
        <span id="pkg-sel-count" style="font-size:12px;color:var(--text-tertiary);display:block;margin-top:8px">${t('packages.selected_count', { n: 0 })}</span>
      </div>

      <!-- Scope: user -->
      <div id="pkg-scope-user" style="${_deployScope!=='user'?'display:none':''}">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">
          <i class="ti ti-infinity" style="color:var(--green);font-size:13px"></i>
          <strong>${t('packages.deploy.user_strong')}</strong> ${t('packages.deploy.user_desc')}
          ${t('packages.deploy.cancelable')}
        </p>
        <div style="position:relative">
          <input class="form-input" id="pkg-user-search" placeholder="${t('packages.deploy.user_search_placeholder')}"
            oninput="pkgUserSearch(this.value)"
            value="${_selectedUser ? esc(_selectedUser.display_name || '') : ''}">
          <div id="pkg-user-results" style="position:absolute;top:100%;left:0;right:0;background:var(--bg-primary);border:0.5px solid var(--border);border-radius:0 0 var(--radius) var(--radius);box-shadow:0 4px 12px rgba(0,0,0,.25);max-height:200px;overflow-y:auto;z-index:100;display:none"></div>
        </div>
        ${_selectedUser ? `<p id="pkg-user-selected" style="font-size:12px;color:var(--green);margin:8px 0 0"><i class="ti ti-check"></i> ${esc(_selectedUser.display_name)}${_selectedUser.email ? ' · ' + esc(_selectedUser.email) : ''}</p>` : '<p id="pkg-user-selected" style="display:none"></p>'}
      </div>

      <!-- Scope: native_group -->
      <div id="pkg-scope-native_group" style="${_deployScope!=='native_group'?'display:none':''}">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">
          <i class="ti ti-infinity" style="color:var(--green);font-size:13px"></i>
          <strong>${t('packages.deploy.native_group_strong')}</strong> ${t('packages.deploy.native_group_desc')}
          ${t('packages.deploy.cancelable')}
        </p>
        <select class="form-input" id="pkg-native-group-select" style="width:100%"
          onchange="pkgSelectNativeGroup(this.value)">
          <option value="">${t('packages.deploy.choose_group')}</option>
          ${_nativeGroups.map(g => `<option value="${esc(g.id)}" ${_selectedNativeGroup?.id===g.id?'selected':''}>${esc(g.name)} (${t('groups.member_count', { n: g.member_count })})</option>`).join('')}
        </select>
      </div>

      <!-- Scope: group -->
      <div id="pkg-scope-group" style="${_deployScope!=='group'?'display:none':''}">
        <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">
          <i class="ti ti-infinity" style="color:var(--green);font-size:13px"></i>
          <strong>${t('packages.deploy.group_strong')}</strong> ${t('packages.deploy.group_desc')}
          ${t('packages.deploy.cancelable')}
        </p>
        <div style="position:relative">
          <input class="form-input" id="pkg-group-search" placeholder="${t('packages.deploy.group_search_placeholder')}"
            oninput="pkgGroupSearch(this.value)"
            value="${_selectedGroup ? esc(_selectedGroup.displayName) : ''}">
          <div id="pkg-group-results" style="position:absolute;top:100%;left:0;right:0;background:var(--bg-primary);border:0.5px solid var(--border);border-radius:0 0 var(--radius) var(--radius);box-shadow:0 4px 12px rgba(0,0,0,.25);max-height:200px;overflow-y:auto;z-index:100;display:none"></div>
        </div>
        ${_selectedGroup ? `<p id="pkg-group-selected" style="font-size:12px;color:var(--green);margin:8px 0 0"><i class="ti ti-check"></i> ${esc(_selectedGroup.displayName)}</p>` : '<p id="pkg-group-selected" style="display:none"></p>'}
      </div>

      <!-- Scope: all -->
      <div id="pkg-scope-all" style="${_deployScope!=='all'?'display:none':''}">
        <div style="background:rgba(245,158,11,.1);border:1px solid var(--amber);border-radius:var(--radius-md);padding:12px 14px;font-size:13px;color:var(--text-primary);display:flex;align-items:flex-start;gap:8px">
          <i class="ti ti-alert-triangle" style="color:var(--amber);font-size:16px;flex-shrink:0;margin-top:1px"></i>
          <div>
            <div style="margin-bottom:6px">
              ${t('packages.deploy.all_warning', { devices: `<strong>${t('packages.deploy.all_devices', { n: _devices.length })}</strong>` })}
            </div>
            <div style="font-size:12px;color:var(--text-secondary)">
              <i class="ti ti-infinity" style="color:var(--green)"></i>
              <strong>${t('packages.deploy.all_strong')}</strong> ${t('packages.deploy.all_desc')}
              ${t('packages.deploy.cancelable')}
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn btn-sm" onclick="closeModal()">${t('btn.cancel')}</button>
        <button class="btn btn-sm btn-primary" onclick="pkgDeploy()"><i class="ti ti-rocket"></i> ${t('packages.btn.deploy')}</button>
      </div>
    </div>`)

  updateSelCount()
  if (_deployScope === 'group' && _selectedGroup) {
    document.getElementById('pkg-group-search').value = _selectedGroup.displayName
  }
}

function renderDeviceCheckboxes(devices) {
  return devices.map(d => `
    <label style="display:flex;align-items:center;gap:10px;padding:7px 8px;cursor:pointer;border-radius:4px" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
      <input type="checkbox" class="pkg-dev-cb" value="${d.id}" onchange="updateSelCount()">
      <span style="flex:1">
        <span style="font-weight:500;font-size:13px">${esc(d.hostname)}</span>
        <span style="font-size:11px;color:var(--text-tertiary);margin-left:8px">${d.ip_netbird ? esc(d.ip_netbird) : ''}</span>
      </span>
      <span class="badge ${d.status === 'online' ? 'b-done' : 'b-closed'}" style="font-size:10px">${esc(d.status)}</span>
    </label>`).join('')
}

window.pkgSetScope = async (scope) => {
  _deployScope = scope
  if (scope === 'native_group' && !_nativeGroups.length) {
    try { _nativeGroups = await window.api.getGroups() } catch (_) {}
  }
  renderDeployModal()
}

window.pkgSelectNativeGroup = (id) => {
  _selectedNativeGroup = _nativeGroups.find(g => g.id === id) || null
}

window.pkgSelectAll = (checked) => {
  document.querySelectorAll('.pkg-dev-cb').forEach(cb => cb.checked = checked)
  updateSelCount()
}

window.pkgFilterOnline = () => {
  const onlineOnly = document.getElementById('pkg-online-only')?.checked
  const list = document.getElementById('pkg-dev-list')
  if (!list) return
  const shown = onlineOnly ? _devices.filter(d => d.status !== 'offline') : _devices
  list.innerHTML = renderDeviceCheckboxes(shown)
  updateSelCount()
}

window.updateSelCount = function updateSelCount() {
  const cbs  = [...document.querySelectorAll('.pkg-dev-cb:checked')]
  const el   = document.getElementById('pkg-sel-count')
  if (el) el.textContent = t('packages.selected_count', { n: cbs.length })
}

window.pkgGroupSearch = (q) => {
  clearTimeout(_groupSearchTimer)
  const results = document.getElementById('pkg-group-results')
  if (!results) return
  if (!q.trim()) { results.style.display = 'none'; return }
  _groupSearchTimer = setTimeout(async () => {
    try {
      const groups = await window.api.searchGroups(q)
      if (!groups.length) {
        results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-tertiary)">${t('groups.search_empty')}</div>`
      } else {
        results.innerHTML = groups.map(g => `
          <div style="padding:8px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''"
               onclick="pkgSelectGroup('${esc(g.id)}', ${jsArg(g.displayName)})">
            <div style="font-weight:500">${esc(g.displayName)}</div>
            ${g.description ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(g.description)}</div>` : ''}
          </div>`).join('')
      }
      results.style.display = 'block'
    } catch (err) {
      results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--red)">${esc(err.message)}</div>`
      results.style.display = 'block'
    }
  }, 250)
}

window.pkgSelectGroup = (id, displayName) => {
  _selectedGroup = { id, displayName }
  const inp = document.getElementById('pkg-group-search')
  if (inp) inp.value = displayName
  const res = document.getElementById('pkg-group-results')
  if (res) res.style.display = 'none'
  const sel = document.getElementById('pkg-group-selected')
  if (sel) { sel.style.display = ''; sel.innerHTML = `<i class="ti ti-check"></i> ${esc(displayName)}` }
}

window.pkgUserSearch = (q) => {
  clearTimeout(_userSearchTimer)
  const results = document.getElementById('pkg-user-results')
  if (!results) return
  if (!q.trim() || q.trim().length < 2) { results.style.display = 'none'; return }
  _userSearchTimer = setTimeout(async () => {
    try {
      const users = await window.api.searchUsers(q)
      if (!users.length) {
        results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-tertiary)">${t('packages.deploy.no_user_found')}</div>`
      } else {
        results.innerHTML = users.map(u => `
          <div style="padding:8px 12px;cursor:pointer;font-size:13px" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''"
               onclick="pkgSelectUser('${esc(u.entra_id)}', ${jsArg(u.display_name || '')}, ${jsArg(u.email || '')})">
            <div style="font-weight:500">${esc(u.display_name)}</div>
            ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
          </div>`).join('')
      }
      results.style.display = 'block'
    } catch (err) {
      results.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--red)">${esc(err.message)}</div>`
      results.style.display = 'block'
    }
  }, 250)
}

window.pkgSelectUser = (entraId, displayName, email) => {
  _selectedUser = { entra_id: entraId, display_name: displayName, email }
  const inp = document.getElementById('pkg-user-search')
  if (inp) inp.value = displayName
  const res = document.getElementById('pkg-user-results')
  if (res) res.style.display = 'none'
  const sel = document.getElementById('pkg-user-selected')
  if (sel) { sel.style.display = ''; sel.innerHTML = `<i class="ti ti-check"></i> ${esc(displayName)}${email ? ' · ' + esc(email) : ''}` }
}

window.pkgShowOutput = (id) => {
  const raw = _outputs.get(id) || ''
  const clean = raw.split(/\r\n|\r|\n/).filter(l => /[a-zA-Z0-9]/.test(l)).join('\n')
  showModal(`
    <div style="padding:20px;min-width:520px">
      <h3 style="margin:0 0 12px;font-size:14px">${t('packages.output.title')}</h3>
      <pre style="font-size:11px;background:var(--bg-secondary);padding:10px 12px;border-radius:var(--radius);overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow-y:auto;margin:0">${esc(clean)}</pre>
      <div style="margin-top:12px;text-align:right"><button class="btn btn-sm" onclick="closeModal()">${t('btn.close')}</button></div>
    </div>`)
}

async function pkgDeploy(confirmed = false) {
  let body

  if (_deployScope === 'device') {
    const ids = [...document.querySelectorAll('.pkg-dev-cb:checked')].map(cb => cb.value)
    if (!ids.length) { showToast(t('packages.deploy.err_no_device'), 'error'); return }
    body = { scope: 'device', device_ids: ids, confirmed }

  } else if (_deployScope === 'native_group') {
    const sel = document.getElementById('pkg-native-group-select')
    const id  = sel?.value || _selectedNativeGroup?.id
    if (!id) { showToast(t('packages.deploy.err_no_native_group'), 'error'); return }
    body = { scope: 'native_group', native_group_id: id, confirmed }

  } else if (_deployScope === 'group') {
    if (!_selectedGroup) { showToast(t('packages.deploy.err_no_group'), 'error'); return }
    body = { scope: 'group', group_id: _selectedGroup.id, confirmed }

  } else if (_deployScope === 'user') {
    if (!_selectedUser) { showToast(t('packages.deploy.err_no_user'), 'error'); return }
    body = { scope: 'user', user_entra_id: _selectedUser.entra_id, confirmed }

  } else {
    body = { scope: 'all', confirmed }
  }

  try {
    const result = await window.api.deployPackage(_selected.id, body)
    if (result?.requires_confirmation) {
      const msg = result.unmatched
        ? t('packages.confirm.deploy_count_unmatched', { n: result.count, unmatched: result.unmatched })
        : t('packages.confirm.deploy_count', { n: result.count })
      if (!confirm(msg)) return
      await pkgDeploy(true)
      return
    }
    closeModal()
    let toast = t('packages.toast.queued', { n: result.queued })
    if (result.unmatched) toast += ` · ${t('packages.toast.unmatched', { n: result.unmatched })}`
    showToast(toast, 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function pkgCancelDeploy(depId) {
  if (!confirm(t('packages.confirm.cancel_dep'))) return
  try {
    await window.api.cancelDeployment(depId)
    showToast(t('packages.toast.dep_cancelled'), 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function pkgRetryDeploy(depId) {
  try {
    await window.api.retryDeployment(depId)
    showToast(t('packages.toast.dep_requeued'), 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function pkgCancelJob(jobId) {
  if (!confirm(t('packages.confirm.stop_job'))) return
  try {
    await window.api.cancelDeploymentJob(jobId)
    showToast(t('packages.toast.job_stopped'), 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

// ── Bulk actions sur la table de déploiements ─────────────────────────────────

// Met à jour le compteur + l'état activé/désactivé des boutons bulk en
// fonction de la sélection courante. Appelée à chaque change sur une
// checkbox de la table.
window.pkgUpdateBulkBar = () => {
  const cbs = [...document.querySelectorAll('.pkg-dep-cb:checked')]
  const count = cbs.length
  const countEl  = document.getElementById('pkg-bulk-count')
  const retryEl  = document.getElementById('pkg-bulk-retry')
  const cancelEl = document.getElementById('pkg-bulk-cancel')
  if (countEl)  countEl.textContent = t('packages.selected_count', { n: count })
  // Active "Rejouer" si au moins un failed/cancelled est sélectionné,
  // "Annuler" si au moins un pending. On ne fait pas tout-ou-rien : la
  // route bulk skip silencieusement les rows non éligibles.
  const hasRetryable  = cbs.some(cb => cb.dataset.status === 'failed' || cb.dataset.status === 'cancelled')
  const hasCancelable = cbs.some(cb => cb.dataset.status === 'pending')
  if (retryEl)  retryEl.disabled  = !hasRetryable
  if (cancelEl) cancelEl.disabled = !hasCancelable
}

// Préfixe pkgDep* : ces sélecteurs ciblent la table des DÉPLOIEMENTS
// (.pkg-dep-cb). À ne pas confondre avec pkgSelectAll plus haut qui
// concerne la modale de déploiement (.pkg-dev-cb = checkboxes devices).
window.pkgDepSelectAll = (checked) => {
  document.querySelectorAll('.pkg-dep-cb').forEach(cb => { cb.checked = !!checked })
  pkgUpdateBulkBar()
}

window.pkgDepSelectNone = () => {
  document.querySelectorAll('.pkg-dep-cb').forEach(cb => { cb.checked = false })
  const all = document.getElementById('pkg-dep-cb-all')
  if (all) all.checked = false
  pkgUpdateBulkBar()
}

window.pkgDepSelectByStatus = (status) => {
  document.querySelectorAll('.pkg-dep-cb').forEach(cb => {
    cb.checked = cb.dataset.status === status
  })
  pkgUpdateBulkBar()
}

async function pkgBulkRetry() {
  const ids = [...document.querySelectorAll('.pkg-dep-cb:checked')]
    .filter(cb => cb.dataset.status === 'failed' || cb.dataset.status === 'cancelled')
    .map(cb => cb.dataset.id)
  if (!ids.length) return
  if (!confirm(t('packages.confirm.bulk_retry', { n: ids.length }))) return
  try {
    const r = await window.api.retryDeploymentsBulk(ids)
    let msg = t('packages.toast.bulk_retried', { n: r.retried })
    if (r.skipped) msg += ` · ${t('packages.toast.bulk_retry_skipped', { n: r.skipped })}`
    showToast(msg, 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

async function pkgBulkCancel() {
  const ids = [...document.querySelectorAll('.pkg-dep-cb:checked')]
    .filter(cb => cb.dataset.status === 'pending')
    .map(cb => cb.dataset.id)
  if (!ids.length) return
  if (!confirm(t('packages.confirm.bulk_cancel', { n: ids.length }))) return
  try {
    const r = await window.api.cancelDeploymentsBulk(ids)
    let msg = t('packages.toast.bulk_cancelled', { n: r.cancelled })
    if (r.skipped) msg += ` · ${t('packages.toast.bulk_cancel_skipped', { n: r.skipped })}`
    showToast(msg, 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

// Coupure d'urgence : annule tous les déploiements pending + stoppe les
// jobs perpétuels actifs. Les running continuent jusqu'à leur fin (l'agent
// les exécute déjà, on ne peut pas les arrêter à distance).
async function pkgCancelAll() {
  if (!_selected) return
  if (!confirm(t('packages.confirm.cancel_all', { name: _selected.name }))) return
  try {
    const r = await window.api.cancelAllDeployments(_selected.id)
    const parts = []
    if (r.cancelled_deployments) parts.push(t('packages.toast.bulk_cancelled', { n: r.cancelled_deployments }))
    if (r.cancelled_jobs)        parts.push(t('packages.toast.jobs_stopped', { n: r.cancelled_jobs }))
    if (r.running_left)          parts.push(t('packages.toast.running_left', { n: r.running_left }))
    showToast(parts.length ? parts.join(' · ') : t('packages.toast.nothing_to_cancel'), 'success')
    await pkgSelect(_selected.id)
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}
