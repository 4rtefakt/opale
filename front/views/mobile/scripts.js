let _scripts = []

// jsArg() fourni globalement par mobile-app.js (window.jsArg)
const mScJsArg = window.jsArg

export async function renderScripts(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 style="flex:1">${t('mobile.scripts.title')}</h1>
      <button class="m-icon-btn" onclick="mScriptNew()" title="${t('mobile.scripts.btn.new')}">
        <i class="ti ti-plus"></i>
      </button>
    </div>
    <div class="m-search">
      <i class="ti ti-search"></i>
      <input type="text" placeholder="${t('mobile.scripts.search_placeholder')}" id="m-scripts-q" oninput="mScriptsFilter()">
    </div>
    <div class="m-scroll-list" id="m-scripts-list">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mScriptsFilter = renderList
  window.mScriptNew     = mScriptNew
  window.mScriptDelete  = mScriptDelete
  window.mSubmitNewScript = mSubmitNewScript

  try {
    _scripts = await window.api.getScripts()
    renderList()
  } catch (err) {
    const list = document.getElementById('m-scripts-list')
    if (list) list.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }
}

function renderList() {
  const q = (document.getElementById('m-scripts-q')?.value || '').toLowerCase()
  const filtered = _scripts.filter(s =>
    !q || s.name.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q)
  )

  const list = document.getElementById('m-scripts-list')
  if (!list) return

  if (!filtered.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.scripts.empty')}</div>`
    return
  }

  // Grouper par catégorie
  const groups = {}
  filtered.forEach(s => {
    const cat = s.category || t('mobile.scripts.default_category')
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(s)
  })

  list.innerHTML = Object.entries(groups).map(([cat, scripts]) => `
    <div class="m-section" style="margin-top:8px;margin-bottom:4px">${esc(cat)}</div>
    ${scripts.map(s => `
      <div class="m-device-card" onclick="mScriptDetail('${esc(s.id)}')">
        <div style="width:32px;height:32px;border-radius:8px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-terminal-2" style="font-size:14px;color:var(--amber)"></i>
        </div>
        <div class="m-device-info">
          <div class="m-device-name">${esc(s.name)}</div>
          ${s.description ? `<div class="m-device-sub">${esc(s.description)}</div>` : ''}
        </div>
        <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:16px;flex-shrink:0"></i>
      </div>`).join('')}
  `).join('')

  window.mScriptDetail = (id) => {
    const s = _scripts.find(x => x.id === id)
    if (!s) return
    window.mShowSheet(`
      <div class="m-sheet-title"><i class="ti ti-terminal-2" style="color:var(--amber)"></i> ${esc(s.name)}</div>
      <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
        ${s.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:0">${esc(s.description)}</p>` : ''}
        ${s.category ? `<div style="font-size:12px;color:var(--text-tertiary)">${t('mobile.scripts.category')} : ${esc(s.category)}</div>` : ''}
        <div>
          <div class="m-label">${t('mobile.scripts.run_on_device')}</div>
          <input class="m-input" id="m-script-hostname-q" placeholder="${t('mobile.scripts.search_device')}"
            autocomplete="off" oninput="mSearchDeviceForScript(this.value)">
          <div id="m-script-device-results" style="margin-top:6px;display:flex;flex-direction:column;gap:4px"></div>
        </div>
        <p style="font-size:11px;color:var(--text-tertiary);margin:0">
          <i class="ti ti-info-circle"></i> ${t('mobile.scripts.checkin_hint')}
        </p>
        <div style="height:1px;background:var(--border);margin:4px 0"></div>
        <button class="m-sheet-btn m-sheet-btn-danger" onclick="mScriptDelete('${esc(s.id)}', ${mScJsArg(s.name)})">
          <i class="ti ti-trash"></i> ${t('mobile.scripts.btn.delete')}
        </button>
      </div>`)

    window.mSearchDeviceForScript = async (q) => {
      const res = document.getElementById('m-script-device-results')
      if (!res || q.length < 2) { if (res) res.innerHTML = ''; return }
      try {
        const data = await window.api.getDevices({ limit: 20 })
        const devices = (data.devices || []).filter(d =>
          d.hostname.toLowerCase().includes(q.toLowerCase()) ||
          (d.user?.name || '').toLowerCase().includes(q.toLowerCase())
        ).slice(0, 5)
        res.innerHTML = devices.map(d => `
          <div class="m-device-card" style="padding:8px 12px" onclick="mRunScriptOn('${esc(s.id)}', '${esc(d.id)}', ${jsArg(d.hostname)})">
            <div class="m-device-info">
              <div class="m-device-name" style="font-size:12px">${esc(d.hostname)}</div>
              ${d.user?.name ? `<div class="m-device-sub">${esc(d.user.name)}</div>` : ''}
            </div>
            <i class="ti ti-player-play" style="color:var(--amber);font-size:16px"></i>
          </div>`).join('')
      } catch {}
    }

    window.mRunScriptOn = async (scriptId, deviceId, hostname) => {
      try {
        await window.api.runScript(scriptId, deviceId)
        window.mCloseSheet()
        window.showToast(t('mobile.scripts.toast.launched', { host: hostname }), 'success')
      } catch { window.showToast(t('mobile.scripts.toast.error'), 'error') }
    }
  }
}

// ── Création (sheet) ─────────────────────────────────────────────────────────

function mScriptNew() {
  // Catégories existantes (pour datalist)
  const categories = [..._scripts.map(s => s.category).filter(Boolean)]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()

  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.scripts.new.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
      <div>
        <div class="m-label">${t('mobile.scripts.new.field.name')} *</div>
        <input class="m-input" id="m-ns-name" placeholder="${t('mobile.scripts.new.placeholder.name')}" autocomplete="off">
      </div>
      <div>
        <div class="m-label">${t('mobile.scripts.new.field.category')}</div>
        <input class="m-input" id="m-ns-cat" list="m-ns-cats" autocomplete="off" placeholder="${t('mobile.scripts.new.placeholder.category')}">
        <datalist id="m-ns-cats">
          ${categories.map(c => `<option value="${esc(c)}">`).join('')}
        </datalist>
      </div>
      <div>
        <div class="m-label">${t('mobile.scripts.new.field.shell')}</div>
        <select class="m-input" id="m-ns-shell">
          <option value="powershell" selected>PowerShell (Windows)</option>
          <option value="bash">Bash (Linux/macOS)</option>
        </select>
      </div>
      <div>
        <div class="m-label">${t('mobile.scripts.new.field.description')}</div>
        <input class="m-input" id="m-ns-desc" autocomplete="off">
      </div>
      <p style="font-size:11px;color:var(--text-tertiary);margin:0">
        <i class="ti ti-info-circle"></i> ${t('mobile.scripts.new.code_hint')}
      </p>
      <button class="m-btn-primary" onclick="mSubmitNewScript()">
        ${t('mobile.scripts.new.create')}
      </button>
    </div>`)
}

async function mSubmitNewScript() {
  const name        = document.getElementById('m-ns-name')?.value?.trim()
  const category    = document.getElementById('m-ns-cat')?.value?.trim()
  const shell_type  = document.getElementById('m-ns-shell')?.value
  const description = document.getElementById('m-ns-desc')?.value?.trim()
  if (!name) {
    window.showToast(t('mobile.scripts.new.name_required'), 'error')
    return
  }
  try {
    const script = await window.api.createScript({
      name, category, shell_type, description,
      code: shell_type === 'powershell' ? '# Script PowerShell\n' : '#!/bin/bash\n'
    })
    _scripts.unshift(script)
    window.mCloseSheet()
    renderList()
    window.showToast(t('mobile.scripts.new.toast_created'), 'success')
  } catch {
    window.showToast(t('mobile.scripts.new.toast_error'), 'error')
  }
}

// ── Suppression (avec confirm) ───────────────────────────────────────────────

async function mScriptDelete(id, name) {
  if (!window.confirm(t('mobile.scripts.delete.confirm', { name }))) return
  try {
    await window.api.deleteScript(id)
    _scripts = _scripts.filter(s => s.id !== id)
    window.mCloseSheet()
    renderList()
    window.showToast(t('mobile.scripts.delete.toast_ok'), 'success')
  } catch {
    window.showToast(t('mobile.scripts.delete.toast_error'), 'error')
  }
}
