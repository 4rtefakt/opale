// Vue Scripts — bibliothèque + exécution SSH avec sortie live
let _scripts    = []
let _activeId   = null
let _execSource = null

export async function renderScripts(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('scripts.title')}</h1>
      <div class="topbar-actions">
        <button class="btn btn-primary" onclick="openNewScriptModal()">
          <i class="ti ti-plus"></i> ${t('scripts.btn.new')}
        </button>
      </div>
    </div>
    <div class="view-split" style="flex:1;min-height:0">
      <!-- Liste des scripts -->
      <div class="ticket-list-col">
        <div class="toolbar" style="padding:8px 10px;border-bottom:0.5px solid var(--border)">
          <input class="search-input" placeholder="${t('scripts.search')}" oninput="filterScripts(this.value)" style="flex:1">
        </div>
        <div class="ticket-list-scroll" id="script-list"></div>
      </div>
      <!-- Éditeur + exécution -->
      <div class="ticket-detail-col" id="script-editor-col">
        <div class="ticket-detail-empty">
          <i class="ti ti-terminal-2" style="font-size:32px"></i>
          <span>${t('scripts.select_hint')}</span>
        </div>
      </div>
    </div>`

  window.filterScripts     = filterScripts
  window.selectScript      = selectScript
  window.saveScript        = saveScript
  window.deleteScript      = deleteScript
  window.openRunModal      = openRunModal
  window.openNewScriptModal = openNewScriptModal

  await loadScripts()
}

async function loadScripts() {
  try {
    _scripts = await window.api.getScripts()
    renderList()
    if (_activeId) selectScript(_activeId)
  } catch { showToast(t('error.generic'), 'error') }
}

function renderList(q = '') {
  const el = document.getElementById('script-list')
  if (!el) return
  const lower = q.toLowerCase()
  const list  = q ? _scripts.filter(s => s.name.toLowerCase().includes(lower)) : _scripts
  if (!list.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem"><i class="ti ti-terminal-2"></i><p>${t('scripts.empty')}</p></div>`
    return
  }
  const builtin = list.filter(s => s.is_builtin)
  const custom  = list.filter(s => !s.is_builtin)

  const renderItem = s => `
    <div class="ticket-item ${_activeId === s.id ? 'active' : ''}" onclick="selectScript('${s.id}')">
      <div class="ti-header">
        <span class="ti-title">${esc(s.name)}</span>
        <span class="badge">${esc(s.shell_type || 'ps')}</span>
      </div>
      <div class="ti-meta">
        ${s.category ? `<span>${esc(s.category)}</span>` : ''}
        ${s.exec_count ? `<span>· ${s.exec_count}× exécuté</span>` : ''}
        ${s.last_run ? `<span>· ${formatRelative(s.last_run)}</span>` : ''}
      </div>
    </div>`

  const sectionHeader = label => `
    <div style="padding:6px 12px 4px;font-size:11px;font-weight:600;color:var(--text-tertiary);
                text-transform:uppercase;letter-spacing:.05em;border-bottom:0.5px solid var(--border)">
      ${label}
    </div>`

  let html = ''
  if (builtin.length) html += sectionHeader(t('scripts.section.builtin')) + builtin.map(renderItem).join('')
  if (custom.length)  html += sectionHeader(t('scripts.section.custom'))  + custom.map(renderItem).join('')
  el.innerHTML = html
}

function filterScripts(q) { renderList(q) }

async function selectScript(id) {
  _activeId = id
  renderList()
  const col = document.getElementById('script-editor-col')
  const s   = _scripts.find(x => x.id === id)
  if (!s) return

  col.innerHTML = `
    <div class="ticket-detail-header">
      <div style="flex:1">
        <div class="ticket-detail-title">${esc(s.name)}</div>
        <div class="ticket-detail-tags">
          ${s.category ? `<span class="badge">${esc(s.category)}</span>` : ''}
          <span class="badge">${esc(s.shell_type || 'powershell')}</span>
          ${s.by_name ? `<span style="font-size:11px;color:var(--text-tertiary)">par ${esc(s.by_name)}</span>` : ''}
        </div>
      </div>
      <div class="ticket-detail-actions">
        ${s.is_builtin ? '' : `<button class="btn btn-sm" onclick="deleteScript('${s.id}')"><i class="ti ti-trash"></i></button>`}
        <button class="btn btn-sm" onclick="openRunModal('${s.id}')">
          <i class="ti ti-player-play"></i> ${t('scripts.btn.run')}
        </button>
        ${s.is_builtin ? '' : `<button class="btn btn-primary btn-sm" onclick="saveScript('${s.id}')">
          <i class="ti ti-device-floppy"></i> ${t('scripts.btn.save')}
        </button>`}
      </div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      ${s.description ? `<div class="desc-box">${esc(s.description)}</div>` : ''}
      <div style="padding:6px 12px;background:var(--bg-secondary);border-bottom:0.5px solid var(--border);display:flex;gap:8px;align-items:center;flex-shrink:0">
        <label style="font-size:12px;color:var(--text-tertiary)">${t('scripts.shell_type')}</label>
        <select class="form-select" id="sc-shell" style="width:140px;padding:4px 8px" ${s.is_builtin ? 'disabled' : ''}>
          <option value="powershell" ${s.shell_type==='powershell'?'selected':''}>PowerShell</option>
          <option value="bash"       ${s.shell_type==='bash'?'selected':''}>Bash</option>
          <option value="cmd"        ${s.shell_type==='cmd'?'selected':''}>CMD</option>
        </select>
      </div>
      <textarea id="sc-code" class="script-editor" spellcheck="false" ${s.is_builtin ? 'readonly style="opacity:.75;cursor:default"' : ''}>${esc(s.code)}</textarea>
    </div>
    <!-- Sortie d'exécution -->
    <div id="exec-panel" class="exec-panel" style="display:none">
      <div class="exec-panel-bar">
        <span>${t('scripts.exec.output')}</span>
        <button class="btn btn-sm" onclick="document.getElementById('exec-panel').style.display='none'">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <div id="exec-output" class="exec-output"></div>
    </div>`

  // Tab dans le textarea → indentation
  document.getElementById('sc-code')?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.target
      const s = ta.selectionStart, end = ta.selectionEnd
      ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(end)
      ta.selectionStart = ta.selectionEnd = s + 2
    }
  })
}

async function saveScript(id) {
  const code       = document.getElementById('sc-code')?.value
  const shell_type = document.getElementById('sc-shell')?.value
  if (!code) return
  try {
    const updated = await window.api.updateScript(id, { code, shell_type })
    const idx = _scripts.findIndex(s => s.id === id)
    if (idx !== -1) _scripts[idx] = { ..._scripts[idx], ...updated }
    showToast(t('scripts.toast.saved'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

async function deleteScript(id) {
  if (!confirm(t('scripts.confirm.delete'))) return
  try {
    await window.api.deleteScript(id)
    _scripts = _scripts.filter(s => s.id !== id)
    _activeId = null
    renderList()
    document.getElementById('script-editor-col').innerHTML = `
      <div class="ticket-detail-empty">
        <i class="ti ti-terminal-2" style="font-size:32px"></i>
        <span>${t('scripts.select_hint')}</span>
      </div>`
    showToast(t('scripts.toast.deleted'), 'info')
  } catch { showToast(t('error.generic'), 'error') }
}

async function openRunModal(id) {
  let devices = [], groups = []
  try { devices = (await window.api.getDevices({ limit: 200 }))?.devices || [] } catch {}
  try { groups  = await window.api.getGroups() } catch {}

  const online = devices.filter(d => d.ip_netbird && d.status !== 'offline')

  const groupOptions = groups
    .filter(g => g.member_count > 0)
    .map(g => `<option value="${esc(g.id)}">${esc(g.name)} (${g.member_count} poste${g.member_count!==1?'s':''})</option>`)
    .join('')

  showModal(`
    <div class="modal-title">${t('scripts.run.title')}</div>
    <div style="display:flex;gap:2px;background:var(--bg-secondary);border-radius:var(--radius-md);padding:3px;margin-bottom:12px">
      <button id="run-tab-devices" class="btn btn-sm btn-primary" style="flex:1;justify-content:center"
        onclick="switchRunTab('devices')"><i class="ti ti-device-laptop" style="font-size:13px"></i> Postes</button>
      <button id="run-tab-group" class="btn btn-sm" style="flex:1;justify-content:center"
        onclick="switchRunTab('group')"><i class="ti ti-circles" style="font-size:13px"></i> Groupe natif</button>
    </div>

    <div id="run-panel-devices">
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input class="search-input" placeholder="${t('scripts.run.search_device')}" oninput="filterRunDevices(this.value)" style="flex:1">
        <button class="btn btn-sm" onclick="selectAllDevices()">${t('scripts.run.select_all')}</button>
      </div>
      <div id="run-device-list" style="max-height:220px;overflow-y:auto;border:0.5px solid var(--border);border-radius:var(--radius-md)">
        ${online.map(d => `
          <label class="run-device-row">
            <input type="checkbox" class="run-device-cb" value="${d.id}">
            <span class="badge badge-${d.status === 'online' ? 'green' : 'orange'}" style="width:8px;height:8px;padding:0;border-radius:50%"></span>
            <span style="flex:1;font-size:13px">${esc(d.hostname)}</span>
            <span style="font-size:11px;color:var(--text-tertiary)">${esc(d.ip_netbird || '')}</span>
          </label>`).join('')}
      </div>
    </div>

    <div id="run-panel-group" style="display:none">
      ${groupOptions
        ? `<select class="form-input" id="run-group-select" style="width:100%">
            <option value="">— Choisir un groupe —</option>
            ${groupOptions}
          </select>`
        : `<p style="font-size:13px;color:var(--text-tertiary)">Aucun groupe natif avec des postes membres.</p>`}
    </div>

    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitRun('${id}')">
        <i class="ti ti-player-play"></i> ${t('scripts.btn.run')}
      </button>
    </div>`)

  window.switchRunTab = (tab) => {
    document.getElementById('run-panel-devices').style.display = tab === 'devices' ? '' : 'none'
    document.getElementById('run-panel-group').style.display   = tab === 'group'   ? '' : 'none'
    document.getElementById('run-tab-devices').classList.toggle('btn-primary', tab === 'devices')
    document.getElementById('run-tab-group').classList.toggle('btn-primary', tab === 'group')
  }
  window.filterRunDevices = (q) => {
    const lower = q.toLowerCase()
    document.querySelectorAll('.run-device-row').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(lower) ? '' : 'none'
    })
  }
  window.selectAllDevices = () => {
    document.querySelectorAll('.run-device-cb').forEach(cb => cb.checked = true)
  }
  window.submitRun = (scriptId) => runScript(scriptId)
}

async function runScript(id) {
  // Détermine si on est en mode "groupe natif" ou "postes individuels"
  const groupPanel   = document.getElementById('run-panel-group')
  const groupVisible = groupPanel && groupPanel.style.display !== 'none'
  const native_group_id = groupVisible ? (document.getElementById('run-group-select')?.value || '') : ''

  let body
  if (native_group_id) {
    body = { native_group_id }
  } else {
    const checked = [...document.querySelectorAll('.run-device-cb:checked')].map(cb => cb.value)
    if (!checked.length) { showToast(t('scripts.run.no_device'), 'error'); return }
    body = { deviceIds: checked }
  }
  closeModal()

  const panel = document.getElementById('exec-panel')
  const output = document.getElementById('exec-output')
  if (!panel || !output) return
  panel.style.display = 'flex'
  output.innerHTML = `<div style="color:var(--text-tertiary);font-size:12px">${t('scripts.exec.starting')}</div>`

  if (_execSource) { _execSource.close(); _execSource = null }

  const token = await window.auth.getToken()
  const res = await fetch(`${window.ENV?.API_BASE_URL || '/api'}/scripts/${id}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    output.innerHTML = `<div class="exec-line err">${esc(err.error || 'Erreur')}</div>`
    return
  }

  output.innerHTML = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const readChunk = async () => {
    const { done, value } = await reader.read()
    if (done) return

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const msg = JSON.parse(line.slice(6))
        appendExecLine(output, msg)
      } catch {}
    }
    await readChunk()
  }

  readChunk().catch(() => {})
}

function appendExecLine(output, msg) {
  if (msg.type === 'end') {
    const el = document.createElement('div')
    el.className = 'exec-line sys'
    el.textContent = '── Terminé ──'
    output.appendChild(el)
    output.scrollTop = output.scrollHeight
    return
  }
  const el = document.createElement('div')
  el.className = `exec-line ${msg.type === 'stderr' || msg.type === 'error' ? 'err' : msg.type === 'connected' || msg.type === 'done' ? 'sys' : ''}`
  const prefix = msg.hostname ? `[${msg.hostname}] ` : ''
  el.textContent = prefix + (typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data))
  output.appendChild(el)
  output.scrollTop = output.scrollHeight
}

function openNewScriptModal() {
  showModal(`
    <div class="modal-title">${t('scripts.new.title')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('scripts.new.name')}</label>
        <input class="form-input" id="ns-name" placeholder="${t('scripts.new.name_placeholder')}">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('scripts.new.category')}</label>
          <input class="form-input" id="ns-cat" list="sc-cats">
          <datalist id="sc-cats">
            ${[..._scripts.map(s => s.category).filter(Boolean)].filter((v,i,a) => a.indexOf(v)===i)
              .map(c => `<option value="${esc(c)}">`).join('')}
          </datalist>
        </div>
        <div class="form-row">
          <label class="form-label">${t('scripts.shell_type')}</label>
          <select class="form-select" id="ns-shell">
            <option value="powershell">PowerShell</option>
            <option value="bash">Bash</option>
            <option value="cmd">CMD</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${t('scripts.new.description')}</label>
        <input class="form-input" id="ns-desc">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitNewScript()">${t('btn.create')}</button>
    </div>`)

  window.submitNewScript = async () => {
    const name       = document.getElementById('ns-name')?.value?.trim()
    const category   = document.getElementById('ns-cat')?.value?.trim()
    const shell_type = document.getElementById('ns-shell')?.value
    const description = document.getElementById('ns-desc')?.value?.trim()
    if (!name) { showToast(t('scripts.new.name_required'), 'error'); return }
    try {
      const script = await window.api.createScript({
        name, category, shell_type, description,
        code: shell_type === 'powershell' ? '# Script PowerShell\n' : '#!/bin/bash\n'
      })
      _scripts.unshift(script)
      closeModal()
      renderList()
      selectScript(script.id)
      showToast(t('scripts.toast.created'), 'success')
    } catch { showToast(t('error.generic'), 'error') }
  }
}
