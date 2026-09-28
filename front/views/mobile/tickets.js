let _tickets = []
let _filter  = 'open'
let _allTags = []
let _adv     = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
let _q       = ''            // recherche fulltext (déléguée au backend via ?q=)
let _searchTimer = null

const M_TAG_PALETTE = {
  slate:  '#475569', blue:   '#2563eb', green:  '#059669', amber:  '#d97706',
  red:    '#dc2626', violet: '#7c3aed', pink:   '#db2777', teal:   '#0d9488',
}

// jsArg() fourni globalement par mobile-app.js (window.jsArg)
const mJsArg = window.jsArg

function shortName(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] || ''
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.'
}

function displayWhen(tk) {
  if (!tk.updated_at || tk.updated_at === tk.created_at) return formatRelative(tk.created_at)
  return `MAJ ${formatRelative(tk.updated_at)}`
}

function proposalMobileCard(p) {
  const sourceMap = { alert: '⚠ Alerte', script: '⚙ Script', email: '✉ Mail IA', manual: 'Manuel' }
  const sourceLabel = sourceMap[p.source] || p.source
  const prioColor = p.suggested_priority === 'critical' ? 'var(--red)' : p.suggested_priority === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
  return `
    <div class="m-device-card" style="display:block">
      <div style="font-weight:500;font-size:14px;margin-bottom:4px">${esc(p.suggested_title)}</div>
      <div style="font-size:11px;color:var(--text-tertiary);display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span style="background:var(--bg-secondary);padding:1px 6px;border-radius:8px">${esc(sourceLabel)}</span>
        <span style="color:${prioColor}">● ${prioLabel(p.suggested_priority)}</span>
        <span>${formatRelative(p.created_at)}</span>
      </div>
      ${p.suggested_description ? `<div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;max-height:80px;overflow:auto;margin-bottom:6px">${esc(p.suggested_description)}</div>` : ''}
      <div style="display:flex;gap:6px;justify-content:flex-end">
        <button class="m-pill m-pill-off" style="border:none;font-size:12px;padding:6px 12px" onclick="mTkRejectProposal('${esc(p.id)}',this)">Rejeter</button>
        <button class="m-pill m-pill-on" style="border:none;font-size:12px;padding:6px 12px" onclick="mTkAcceptProposal('${esc(p.id)}',this)">Accepter</button>
      </div>
    </div>`
}

async function mTkAcceptProposal(id, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.acceptProposal(id, {})
      window.showToast('Ticket créé depuis proposition', 'success')
      loadTickets()
    } catch (err) {
      window.showToast(err.message || 'Erreur', 'error')
    }
  })
}

async function mTkRejectProposal(id, btn) {
  const reason = prompt('Raison du rejet (optionnel) :')
  if (reason === null) return
  await withBusy(btn, async () => {
    try {
      await window.api.rejectProposal(id, reason || null)
      window.showToast('Proposition rejetée', 'info')
      loadTickets()
    } catch (err) {
      window.showToast(err.message || 'Erreur', 'error')
    }
  })
}

export async function renderTickets(el) {
  _filter = 'open'
  _adv    = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
  _q      = ''
  el.innerHTML = `
    <div class="m-header">
      <h1>Tickets <span id="m-tk-count" style="font-size:12px;font-weight:400;color:var(--text-tertiary)"></span></h1>
      <button class="m-icon-btn" onclick="mTkOpenFilters()" id="m-tk-filters-btn" title="Filtres">
        <i class="ti ti-filter"></i>
      </button>
      <button class="m-icon-btn" onclick="mNewTicket()">
        <i class="ti ti-plus"></i>
      </button>
    </div>
    <div class="m-search">
      <i class="ti ti-search"></i>
      <input type="text" placeholder="${t('mobile.tickets.search_ph')}" id="m-tk-q" oninput="mTkFilter()">
    </div>
    <div class="m-filters">
      <button class="m-filter-pill" data-f="all"         onclick="mTkSetFilter('all',this)">Tous</button>
      <button class="m-filter-pill active" data-f="open" onclick="mTkSetFilter('open',this)">Ouverts</button>
      <button class="m-filter-pill" data-f="in_progress" onclick="mTkSetFilter('in_progress',this)">En cours</button>
      <button class="m-filter-pill" data-f="auto"        onclick="mTkSetFilter('auto',this)">Auto</button>
      <button class="m-filter-pill" data-f="resolved"    onclick="mTkSetFilter('resolved',this)">Résolus</button>
      <button class="m-filter-pill" data-f="closed"      onclick="mTkSetFilter('closed',this)">Archivés</button>
      <button class="m-filter-pill" data-f="inbox"       onclick="mTkSetFilter('inbox',this)" id="m-tk-inbox-pill" style="display:none">✉ ${t('mobile.tickets.inbox_pill')}</button>
      <button class="m-filter-pill" data-f="proposed"    onclick="mTkSetFilter('proposed',this)" id="m-tk-proposed-pill" style="display:none">💡 Proposés</button>
    </div>
    <div id="m-tk-active-chips" style="padding:6px 12px;display:none;flex-wrap:wrap;gap:4px"></div>
    <div class="m-scroll-list" id="m-tk-list">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  // Recherche : filtre local immédiat (titre/hostname pour la réactivité)
  // puis appel backend débounce avec ?q= (matche aussi description, messages
  // et personnes concernées — comme le desktop).
  window.mTkFilter    = () => {
    _q = document.getElementById('m-tk-q')?.value || ''
    renderList()
    if (_searchTimer) clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => { _searchTimer = null; loadTickets() }, 300)
  }
  window.mTkSetFilter = (f, btn) => {
    _filter = f
    el.querySelectorAll('.m-filter-pill').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    loadTickets()
  }
  window.mTkOpenFilters = mTkOpenFilters
  window.mTkApplyAdv    = mTkApplyAdv
  window.mTkClearAdv    = mTkClearAdv
  window.mTkRemoveChip  = mTkRemoveChip
  window.mTkAcceptProposal = mTkAcceptProposal
  window.mTkRejectProposal = mTkRejectProposal
  window.mInboxOpen        = mInboxOpen
  window.mInboxToTicket    = mInboxToTicket
  window.mInboxDismiss     = mInboxDismiss
  window.mInboxAttach      = mInboxAttach
  window.mNewTicket = () => {
    // État local de la modale (closure)
    const me = window.appState?.user
    let pickedAssignee  = null  // { entra_id, display_name }
    let pickedRequester = null  // { entra_id, display_name, email }
    let pickedDevice    = null  // { id, hostname }
    let selectedTags    = []    // [{ id, name, color }, ...]
    let _devCache       = null  // liste devices chargée à la demande

    window.mShowSheet(`
      <div class="m-sheet-title">${t('mobile.tickets.new.title')}</div>
      <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.title')}</div>
          <input class="m-input" id="m-nti-title" placeholder="${t('mobile.tickets.new.placeholder.title')}" autocomplete="off">
        </div>
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.priority')}</div>
          <select class="m-input" id="m-nti-prio">
            <option value="low">${t('prio.low')}</option>
            <option value="normal" selected>${t('prio.normal')}</option>
            <option value="high">${t('prio.high')}</option>
            <option value="critical">${t('prio.critical')}</option>
          </select>
        </div>

        <!-- Assignee : me prendre en charge / désassigner -->
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.assignee')}</div>
          <div id="m-nti-assignee" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"></div>
        </div>

        <!-- Requester : search + picker -->
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.requester')}</div>
          <div id="m-nti-requester" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"></div>
          <div id="m-nti-requester-search" style="display:none;margin-top:6px">
            <input class="m-input" id="m-nti-rq" placeholder="${t('mobile.tickets.new.requester_search')}" autocomplete="off">
            <div id="m-nti-rr" style="max-height:160px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px"></div>
          </div>
        </div>

        <!-- Poste concerné : search + picker -->
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.device')}</div>
          <div id="m-nti-device" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"></div>
          <div id="m-nti-device-search" style="display:none;margin-top:6px">
            <input class="m-input" id="m-nti-dq" placeholder="${t('mobile.tickets.new.device_search')}" autocomplete="off">
            <div id="m-nti-dr" style="max-height:160px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px"></div>
          </div>
        </div>

        <!-- Tags : picker compact -->
        <div>
          <div class="m-label">${t('mobile.tickets.new.field.tags')}</div>
          <div id="m-nti-tags" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center"></div>
          <div id="m-nti-tags-search" style="display:none;margin-top:6px">
            <input class="m-input" id="m-nti-tq" placeholder="${t('mobile.tickets.new.tags_search')}" autocomplete="off">
            <div id="m-nti-tl" style="max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin-top:4px"></div>
          </div>
        </div>

        <div>
          <div class="m-label">${t('mobile.tickets.new.field.description')}</div>
          <textarea class="m-input" id="m-nti-desc" rows="3" style="resize:none" placeholder="${t('mobile.tickets.new.placeholder.description')}"></textarea>
        </div>

        <button class="m-btn-primary" onclick="mSubmitNewTicket(this)">${t('mobile.tickets.new.create')}</button>
      </div>`)

    // ─── Assignee : self-assign uniquement (pas de picker tiers en mobile) ───
    function renderAssignee() {
      const row = document.getElementById('m-nti-assignee')
      if (!row) return
      if (pickedAssignee) {
        row.innerHTML = `
          <span style="font-size:13px"><i class="ti ti-user-check" style="font-size:11px;opacity:0.7"></i> ${esc(pickedAssignee.display_name)}</span>
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiUnassign()">${t('mobile.tickets.new.unassign')}</button>`
      } else {
        row.innerHTML = `
          <span style="font-size:13px;color:var(--text-tertiary)">${t('mobile.tickets.new.unassigned')}</span>
          ${me?.entraId ? `<button class="m-pill m-pill-on" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiAssignSelf()">${t('mobile.tickets.new.assign_self')}</button>` : ''}`
      }
    }
    window.mNtiAssignSelf = () => {
      if (!me?.entraId) return
      pickedAssignee = { entra_id: me.entraId, display_name: me.displayName }
      renderAssignee()
    }
    window.mNtiUnassign = () => { pickedAssignee = null; renderAssignee() }

    // ─── Requester : search avec debounce ───────────────────────────────────
    function renderRequester() {
      const row = document.getElementById('m-nti-requester')
      if (!row) return
      if (pickedRequester) {
        row.innerHTML = `
          <span style="font-size:13px"><i class="ti ti-user" style="font-size:11px;opacity:0.7"></i> ${esc(pickedRequester.display_name)}</span>
          ${pickedRequester.email ? `<span style="font-size:11px;color:var(--text-tertiary)">${esc(pickedRequester.email)}</span>` : ''}
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiClearRequester()">${t('mobile.tickets.new.clear')}</button>`
      } else {
        row.innerHTML = `
          <span style="font-size:13px;color:var(--text-tertiary)">${t('mobile.tickets.new.no_requester')}</span>
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiToggleRequesterSearch()">
            <i class="ti ti-search" style="font-size:11px"></i> ${t('mobile.tickets.new.requester_pick')}
          </button>`
      }
    }
    window.mNtiClearRequester = () => { pickedRequester = null; renderRequester() }
    window.mNtiToggleRequesterSearch = () => {
      const box = document.getElementById('m-nti-requester-search')
      if (!box) return
      const isOpen = box.style.display === 'block'
      box.style.display = isOpen ? 'none' : 'block'
      if (!isOpen) setTimeout(() => document.getElementById('m-nti-rq')?.focus(), 50)
    }
    window.mNtiApplyRequester = (entraId, name, email) => {
      pickedRequester = { entra_id: entraId, display_name: name, email: email || '' }
      const sb = document.getElementById('m-nti-requester-search'); if (sb) sb.style.display = 'none'
      const inp = document.getElementById('m-nti-rq'); if (inp) inp.value = ''
      const lst = document.getElementById('m-nti-rr'); if (lst) lst.innerHTML = ''
      renderRequester()
    }
    let requesterTimer
    setTimeout(() => {
      document.getElementById('m-nti-rq')?.addEventListener('input', (e) => {
        clearTimeout(requesterTimer)
        const q = e.target.value.trim()
        const lst = document.getElementById('m-nti-rr')
        if (q.length < 2) { if (lst) lst.innerHTML = ''; return }
        requesterTimer = setTimeout(async () => {
          const users = await window.api.searchUsers(q).catch(() => [])
          if (!lst) return
          lst.innerHTML = users.length
            ? users.map(u => `
                <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                  onclick="mNtiApplyRequester(${mJsArg(u.entra_id)}, ${mJsArg(u.display_name || '')}, ${mJsArg(u.email || '')})">
                  <div style="font-size:13px">${esc(u.display_name)}</div>
                  ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
                </div>`).join('')
            : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('mobile.tickets.new.no_match')}</div>`
        }, 200)
      })
    }, 0)

    // ─── Poste concerné : search local sur getDevices ───────────────────────
    function renderDevice() {
      const row = document.getElementById('m-nti-device')
      if (!row) return
      if (pickedDevice) {
        row.innerHTML = `
          <span style="font-size:13px"><i class="ti ti-device-laptop" style="font-size:11px;opacity:0.7"></i> ${esc(pickedDevice.hostname || pickedDevice.id)}</span>
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiClearDevice()">${t('mobile.tickets.new.clear')}</button>`
      } else {
        row.innerHTML = `
          <span style="font-size:13px;color:var(--text-tertiary)">${t('mobile.tickets.new.no_device')}</span>
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiToggleDeviceSearch()">
            <i class="ti ti-search" style="font-size:11px"></i> ${t('mobile.tickets.new.device_pick')}
          </button>`
      }
    }
    window.mNtiClearDevice = () => { pickedDevice = null; renderDevice() }
    window.mNtiToggleDeviceSearch = () => {
      const box = document.getElementById('m-nti-device-search')
      if (!box) return
      const isOpen = box.style.display === 'block'
      box.style.display = isOpen ? 'none' : 'block'
      if (!isOpen) {
        renderDeviceResults()
        setTimeout(() => document.getElementById('m-nti-dq')?.focus(), 50)
      }
    }
    window.mNtiApplyDevice = (id, hostname) => {
      pickedDevice = { id, hostname }
      const sb = document.getElementById('m-nti-device-search'); if (sb) sb.style.display = 'none'
      const inp = document.getElementById('m-nti-dq'); if (inp) inp.value = ''
      const lst = document.getElementById('m-nti-dr'); if (lst) lst.innerHTML = ''
      renderDevice()
    }
    async function renderDeviceResults() {
      const lst = document.getElementById('m-nti-dr')
      if (!lst) return
      if (!_devCache) {
        lst.innerHTML = `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">…</div>`
        try { _devCache = (await window.api.getDevices({ limit: 200 }))?.devices || [] }
        catch { _devCache = [] }
      }
      const q = (document.getElementById('m-nti-dq')?.value || '').trim().toLowerCase()
      const filtered = (q
        ? _devCache.filter(d => (d.hostname || '').toLowerCase().includes(q) ||
                                (d.user_name || '').toLowerCase().includes(q) ||
                                (d.model || '').toLowerCase().includes(q))
        : _devCache).slice(0, 50)
      lst.innerHTML = filtered.length
        ? filtered.map(d => `
            <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
              onclick="mNtiApplyDevice('${esc(d.id)}', ${mJsArg(d.hostname || '')})">
              <div style="font-size:13px">${esc(d.hostname || '?')}</div>
              <div style="font-size:11px;color:var(--text-tertiary)">${esc(d.user_name || '')}${d.model ? ' · ' + esc(d.model) : ''}</div>
            </div>`).join('')
        : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('mobile.tickets.new.no_match')}</div>`
    }
    setTimeout(() => {
      document.getElementById('m-nti-dq')?.addEventListener('input', renderDeviceResults)
    }, 0)

    // ─── Tags : picker compact ──────────────────────────────────────────────
    function renderTags() {
      const area = document.getElementById('m-nti-tags')
      if (!area) return
      const chips = selectedTags.map(g => {
        const color = M_TAG_PALETTE[g.color] || M_TAG_PALETTE.slate
        return `
          <span style="display:inline-flex;align-items:center;gap:4px;background:${color};color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">
            ${esc(g.name)}
            <i class="ti ti-x" style="cursor:pointer;font-size:11px;padding:8px;margin:-8px -4px -8px 0" onclick="mNtiRemoveTag('${esc(g.id)}')"></i>
          </span>`
      }).join('')
      area.innerHTML = chips + `
        <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiToggleTagSearch()">
          <i class="ti ti-plus" style="font-size:11px"></i> ${t('mobile.tickets.new.tags_add')}
        </button>`
    }
    window.mNtiToggleTagSearch = () => {
      const box = document.getElementById('m-nti-tags-search')
      if (!box) return
      const isOpen = box.style.display === 'block'
      box.style.display = isOpen ? 'none' : 'block'
      if (!isOpen) {
        renderTagSearch()
        setTimeout(() => document.getElementById('m-nti-tq')?.focus(), 50)
      }
    }
    window.mNtiRemoveTag = (tagId) => {
      selectedTags = selectedTags.filter(g => g.id !== tagId)
      renderTags()
    }
    function renderTagSearch() {
      const q = (document.getElementById('m-nti-tq')?.value || '').trim().toLowerCase()
      const lst = document.getElementById('m-nti-tl')
      if (!lst) return
      const taken = new Set(selectedTags.map(g => g.id))
      const matching = (_allTags || []).filter(g => g.name.toLowerCase().includes(q))
      const exact = (_allTags || []).find(g => g.name.toLowerCase() === q)
      let html = matching.map(g => {
        const color = M_TAG_PALETTE[g.color] || M_TAG_PALETTE.slate
        const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:6px;vertical-align:middle"></span>`
        if (taken.has(g.id)) {
          return `<div style="padding:6px 10px;opacity:0.5;font-size:13px">${swatch}${esc(g.name)} <span style="font-size:10px;color:var(--text-tertiary)">— ${t('mobile.tickets.new.tag_already')}</span></div>`
        }
        return `<div style="padding:6px 10px;cursor:pointer;font-size:13px" onclick="mNtiPickTag('${esc(g.id)}')">${swatch}${esc(g.name)}</div>`
      }).join('')
      if (q && !exact) {
        html += `<div style="padding:8px 10px;border-top:0.5px solid var(--border)">
          <button class="m-pill m-pill-on" style="border:none;cursor:pointer;font-size:11px" onclick="mNtiCreateAndAddTag(${mJsArg(q)}, this)">
            <i class="ti ti-plus" style="font-size:11px"></i> ${t('mobile.tickets.new.tag_create')} « ${esc(q)} »
          </button>
        </div>`
      }
      if (!html) html = `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('mobile.tickets.new.tag_empty')}</div>`
      lst.innerHTML = html
    }
    window.mNtiPickTag = (tagId) => {
      const g = (_allTags || []).find(x => x.id === tagId)
      if (g && !selectedTags.some(x => x.id === g.id)) selectedTags.push(g)
      const inp = document.getElementById('m-nti-tq'); if (inp) inp.value = ''
      renderTags()
      renderTagSearch()
    }
    window.mNtiCreateAndAddTag = async (name, btn) => {
      await withBusy(btn, async () => {
        try {
          const newTag = await window.api.createTag({ name: name.trim(), color: 'slate' })
          _allTags.push(newTag)
          _allTags.sort((a, b) => a.name.localeCompare(b.name))
          selectedTags.push(newTag)
          const inp = document.getElementById('m-nti-tq'); if (inp) inp.value = ''
          renderTags()
          renderTagSearch()
        } catch { window.showToast(t('mobile.tickets.new.tag_create_error'), 'error') }
      })
    }
    setTimeout(() => {
      document.getElementById('m-nti-tq')?.addEventListener('input', renderTagSearch)
    }, 0)

    // ─── Submit ────────────────────────────────────────────────────────────
    window.mSubmitNewTicket = async (btn) => {
      const title = document.getElementById('m-nti-title')?.value?.trim()
      if (!title) { window.showToast(t('mobile.tickets.new.title_required'), 'error'); return }
      await withBusy(btn, async () => {
        try {
          const tk = await window.api.createTicket({
            title,
            priority:    document.getElementById('m-nti-prio')?.value,
            description: document.getElementById('m-nti-desc')?.value?.trim(),
            assigned_to_entra_id: pickedAssignee?.entra_id   || null,
            assigned_to_name:     pickedAssignee?.display_name || null,
            user_id:              pickedRequester?.entra_id || null,
            device_id:            pickedDevice?.id || null,
            tag_ids:              selectedTags.map(g => g.id),
          })
          window.mCloseSheet()
          _tickets.unshift(tk)
          renderList()
          window.showToast(t('mobile.tickets.new.toast_created'), 'success')
        } catch {
          window.showToast(t('mobile.tickets.new.toast_error'), 'error')
        }
      })
    }

    // Render initial des sections dynamiques
    renderAssignee()
    renderRequester()
    renderDevice()
    renderTags()
  }

  // Précharge tags pour l'affichage et les filtres
  window.api.getTags().then(t => { _allTags = t || [] }).catch(() => { _allTags = [] })

  await loadTickets()
}

async function loadTickets() {
  const list = document.getElementById('m-tk-list')
  if (!list) return
  list.innerHTML = `<div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>`
  try {
    if (_filter === 'proposed') {
      // Mode propositions : on liste depuis la table dédiée ticket_proposals
      _tickets = await window.api.getProposals({ status: 'pending' })
      _tickets = _tickets.map(p => ({ ...p, _isProposal: true }))
    } else if (_filter === 'inbox') {
      // Mode « À trier » : mails entrants sans ticket, regroupés par fil.
      _inboxThreads = groupInboxThreads(await window.api.getInbox({ limit: 500 }))
      _tickets = []
    } else {
      const params = {}
      // 'auto' = is_auto sans contrainte de statut ; 'closed' = archives
      // (opt-in côté backend) ; sinon le statut tel quel (sauf 'all').
      if (_filter === 'auto')      params.is_auto = 'true'
      else if (_filter !== 'all')  params.status  = _filter
      if (_adv.priority.length)    params.priority    = _adv.priority.join(',')
      if (_adv.tag.length)         params.tag         = _adv.tag.join(',')
      if (_adv.assigned_to)        params.assigned_to = _adv.assigned_to
      if (_adv.created_from)       params.created_from = _adv.created_from
      if (_adv.created_to)         params.created_to   = _adv.created_to
      if (_q.trim())               params.q            = _q.trim()
      _tickets = await window.api.getTickets(params)
    }
    renderActiveChips()

    // Toujours raffraichir les compteurs des pills "Proposés" et "À trier"
    if (['all', 'open', 'proposed', 'inbox'].includes(_filter)) {
      try {
        const [{ pending }, inbox] = await Promise.all([
          window.api.getProposalsCount().catch(() => ({ pending: 0 })),
          window.api.getInboxCount().catch(() => ({ pending: 0 })),
        ])
        const pill = document.getElementById('m-tk-proposed-pill')
        if (pill) {
          pill.style.display = pending > 0 ? '' : 'none'
          pill.textContent   = `💡 Proposés (${pending})`
        }
        const ipill = document.getElementById('m-tk-inbox-pill')
        if (ipill) {
          ipill.style.display = (inbox.pending > 0 || _filter === 'inbox') ? '' : 'none'
          ipill.textContent   = `✉ ${t('mobile.tickets.inbox_pill')} (${inbox.pending})`
        }
      } catch {}
    }
    renderList()
  } catch (err) {
    list.innerHTML = mErrorBox(err.message, () => loadTickets())
  }
}

function renderList() {
  if (_filter === 'inbox') return renderInboxList()
  const q       = (document.getElementById('m-tk-q')?.value || '').toLowerCase()
  const matched = _tickets.filter(tk =>
    !q || (tk.title || '').toLowerCase().includes(q) || (tk.hostname || '').toLowerCase().includes(q)
  )
  // Le backend (via ?q=) matche aussi description / messages / personnes —
  // critères absents du payload liste. Si le filtre local ne trouve rien
  // alors que le backend a renvoyé des tickets, on garde la liste backend
  // pour ne pas masquer un résultat valide (cf. desktop applyLocalSearch).
  const filtered = (q && matched.length === 0 && _tickets.length > 0) ? _tickets : matched

  const countEl = document.getElementById('m-tk-count')
  if (countEl) countEl.textContent = `${filtered.length}`

  const list = document.getElementById('m-tk-list')
  if (!list) return

  if (!filtered.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">Aucun ticket</div>`
    return
  }

  // Mode propositions : carte différente avec actions accepter/rejeter
  if (_filter === 'proposed') {
    list.innerHTML = filtered.length
      ? filtered.map(p => proposalMobileCard(p)).join('')
      : `<div style="text-align:center;color:var(--text-tertiary);padding:30px">Aucune proposition</div>`
    return
  }

  list.innerHTML = filtered.map(tk => {
    const pillCls = tk.status === 'resolved' ? 'm-pill-on' : tk.status === 'in_progress' ? 'm-pill-warn' : 'm-pill-off'
    const pillTxt = tk.status === 'resolved' ? 'Résolu' : tk.status === 'in_progress' ? 'En cours' : 'Ouvert'
    const prioColor = tk.priority === 'critical' ? 'var(--red)' : tk.priority === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
    const tags = (tk.tags || []).slice(0, 3).map(g =>
      `<span class="m-ticket-tag" style="background:${M_TAG_PALETTE[g.color] || M_TAG_PALETTE.slate}">${esc(g.name)}</span>`
    ).join('')
    // Une seule ligne méta : pastille de priorité (seul fragment coloré),
    // poste, demandeur (ti-user) et assigné (ti-user-check, icône distincte),
    // puis l'horodatage. La ligne tronque proprement (ellipsis) si trop longue.
    const meta = [
      `<span class="m-ticket-prio-dot" style="background:${prioColor}"></span>${prioLabel(tk.priority)}`,
      tk.hostname        ? `<i class="ti ti-device-laptop"></i>${esc(tk.hostname)}` : '',
      tk.requester_name  ? `<i class="ti ti-user"></i>${esc(shortName(tk.requester_name))}` : '',
      tk.assigned_to_name? `<i class="ti ti-user-check"></i>${esc(shortName(tk.assigned_to_name))}` : '',
      displayWhen(tk),
    ].filter(Boolean).join('<span class="m-ticket-sep">·</span>')
    return `
      <div class="m-ticket-card" onclick="window.location.hash='#/ticket/${esc(tk.id)}'">
        <div class="m-ticket-top">
          ${tk.awaiting_reply ? '<span class="m-ticket-unread" title="Réponse en attente"></span>' : ''}
          <div class="m-ticket-title">${esc(tk.title)}</div>
          <span class="m-pill ${pillCls}">${pillTxt}</span>
        </div>
        <div class="m-ticket-meta">${meta}</div>
        ${tags ? `<div class="m-ticket-tags">${tags}</div>` : ''}
      </div>`
  }).join('')
}

// ── Mails à trier (mobile) ─────────────────────────────────────────────────
// Un fil (= conversation Outlook) par carte ; le sheet montre les mails du
// fil avec leur corps complet, puis : créer un ticket / rattacher / ignorer.

let _inboxThreads = []

function groupInboxThreads(mails) {
  const map = new Map()
  for (const m of mails || []) {
    const key = m.conversation_id || m.id
    if (!map.has(key)) map.set(key, { key, mails: [] })
    map.get(key).mails.push(m)
  }
  return [...map.values()].map(th => {
    th.mails.sort((a, b) => Date.parse(a.received_at || 0) - Date.parse(b.received_at || 0))
    th.latest = th.mails[th.mails.length - 1]
    th.count  = Math.max(th.mails.length, th.latest.thread_count || 1)
    return th
  }).sort((a, b) => Date.parse(b.latest.received_at || 0) - Date.parse(a.latest.received_at || 0))
}

function cleanSubjectM(s) {
  return String(s || '').replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim() || t('mobile.tickets.inbox.no_subject')
}

function renderInboxList() {
  const list = document.getElementById('m-tk-list')
  if (!list) return
  const q = (document.getElementById('m-tk-q')?.value || '').toLowerCase()
  const threads = _inboxThreads.filter(th => !q
    || (th.latest.subject || '').toLowerCase().includes(q)
    || th.mails.some(m => (m.from_name || m.from_address || '').toLowerCase().includes(q)))
  const countEl = document.getElementById('m-tk-count')
  if (countEl) countEl.textContent = `${threads.length}`
  if (!threads.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px">${t('mobile.tickets.inbox.empty')}</div>`
    return
  }
  list.innerHTML = threads.map(th => {
    const m = th.latest
    return `
      <div class="m-ticket-card" onclick="mInboxOpen(${mJsArg(th.key)})">
        <div class="m-ticket-top">
          <div class="m-ticket-title">${esc(cleanSubjectM(m.subject))}</div>
          ${th.count > 1 ? `<span class="m-pill m-pill-warn">${th.count} ✉</span>` : ''}
        </div>
        <div class="m-ticket-meta"><i class="ti ti-user"></i>${esc(m.from_name || m.from_address || '?')}<span class="m-ticket-sep">·</span>${formatRelative(m.received_at)}${m.suggested_device_hostname ? `<span class="m-ticket-sep">·</span><i class="ti ti-device-laptop"></i>${esc(m.suggested_device_hostname)}` : ''}</div>
        ${m.body_preview ? `<div style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.body_preview)}</div>` : ''}
      </div>`
  }).join('')
}

async function mInboxOpen(key) {
  const th = _inboxThreads.find(x => x.key === key)
  if (!th) return
  const m = th.latest
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(cleanSubjectM(m.subject))}</div>
    <div style="padding:0 4px 8px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12px;color:var(--text-tertiary)">
        ${m.suggested_user_name ? `<i class="ti ti-user"></i> ${esc(m.suggested_user_name)} · ${t('mobile.tickets.inbox.will_be_requester')}` : `<i class="ti ti-user-question"></i> ${esc(m.from_address || '')} · ${t('mobile.tickets.inbox.external')}`}
        ${th.count > 1 ? `<br><i class="ti ti-messages"></i> ${t('mobile.tickets.inbox.thread_hint', { n: th.count })}` : ''}
      </div>
      <div id="m-inbox-thread" style="display:flex;flex-direction:column;gap:8px;max-height:45vh;overflow-y:auto">
        <div style="display:flex;justify-content:center;padding:16px"><div class="m-spinner"></div></div>
      </div>
      <button class="m-btn-primary" onclick="mInboxToTicket(${mJsArg(m.id)}, this)"><i class="ti ti-ticket"></i> ${th.count > 1 ? t('mobile.tickets.inbox.to_ticket_n', { n: th.count }) : t('mobile.tickets.inbox.to_ticket')}</button>
      <div style="display:flex;gap:8px">
        <button class="m-filter-pill" style="flex:1;justify-content:center" onclick="mInboxAttach(${mJsArg(m.id)})"><i class="ti ti-arrows-join"></i>&nbsp;${t('mobile.tickets.inbox.attach')}</button>
        <button class="m-filter-pill" style="flex:1;justify-content:center;color:var(--text-tertiary)" onclick="mInboxDismiss(${mJsArg(m.id)}, ${th.count > 1 ? 'true' : 'false'}, this)"><i class="ti ti-eye-off"></i>&nbsp;${t('mobile.tickets.inbox.dismiss')}</button>
      </div>
    </div>`)

  let items
  try { items = await window.api.getInboxThread(m.id) } catch { items = th.mails }
  const host = document.getElementById('m-inbox-thread')
  if (!host) return
  host.innerHTML = items.map(it => `
    <div style="background:var(--bg-tertiary);border-radius:10px;padding:10px 12px;${it.direction === 'outbound' ? 'border:1px solid rgba(34,197,94,.35)' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-tertiary);margin-bottom:4px">
        <span style="font-weight:600;color:var(--text-primary)">${esc(it.from_name || it.from_address || '?')}</span>
        <span>${formatRelative(it.received_at)}</span>
      </div>
      <div id="m-inbox-body-${esc(it.id)}" style="font-size:13px;white-space:pre-wrap;line-height:1.45;color:var(--text-secondary)">${esc(it.body_preview || '')}</div>
    </div>`).join('')
  await Promise.all(items.map(async it => {
    try {
      const b = await window.api.getInboxBody(it.id)
      const el = document.getElementById(`m-inbox-body-${it.id}`)
      if (el && b.body_text) { el.textContent = b.body_text; el.style.color = 'var(--text-primary)' }
    } catch {}
  }))
}

async function mInboxToTicket(mappingId, btn) {
  await withBusy(btn, async () => {
    try {
      const { ticket, absorbed } = await window.api.inboxToTicket(mappingId)
      window.mCloseSheet()
      window.showToast(absorbed > 1 ? t('mobile.tickets.inbox.created_n', { n: absorbed }) : t('mobile.tickets.inbox.created'), 'success')
      if (ticket?.id) window.location.hash = `#/ticket/${ticket.id}`
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  })
}

async function mInboxDismiss(mappingId, wholeThread, btn) {
  if (!confirm(t('mobile.tickets.inbox.confirm_dismiss'))) return
  await withBusy(btn, async () => {
    try {
      await window.api.inboxDismiss(mappingId, wholeThread)
      window.mCloseSheet()
      await loadTickets()
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  })
}

function mInboxAttach(mappingId) {
  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.tickets.inbox.attach_title')}</div>
    <div style="padding:0 4px 8px;display:flex;flex-direction:column;gap:10px">
      <input class="m-input" id="m-inbox-attach-q" placeholder="${esc(t('mobile.tickets.search_ph'))}" autocomplete="off">
      <div id="m-inbox-attach-results" style="max-height:45vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
    </div>`)
  const input = document.getElementById('m-inbox-attach-q')
  const list  = document.getElementById('m-inbox-attach-results')
  setTimeout(() => input?.focus(), 50)
  const search = async () => {
    const q = input.value.trim()
    const params = { limit: 30 }
    if (q) params.q = q
    let tickets = []
    try { tickets = await window.api.getTickets(params) } catch {}
    list.innerHTML = tickets.length ? tickets.map(tk => `
      <div style="padding:10px;cursor:pointer;border-bottom:0.5px solid var(--border)" onclick="window.mInboxConfirmAttach(${mJsArg(mappingId)}, '${esc(tk.id)}')">
        <div style="font-size:13px;font-weight:500">${esc(tk.title)}</div>
        <div style="font-size:11px;color:var(--text-tertiary)">${tk.requester_name ? esc(shortName(tk.requester_name)) + ' · ' : ''}${displayWhen(tk)}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">Aucun ticket</div>`
  }
  let timer
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250) })
  search()
  window.mInboxConfirmAttach = async (mid, ticketId) => {
    try {
      const out = await window.api.inboxAttach(mid, ticketId)
      window.mCloseSheet()
      window.showToast(t('mobile.tickets.inbox.attached', { n: out.appended }), 'success')
      window.location.hash = `#/ticket/${ticketId}`
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  }
}

function renderActiveChips() {
  const el = document.getElementById('m-tk-active-chips')
  if (!el) return
  const chips = []
  for (const p of _adv.priority) chips.push(advChip(`Priorité: ${prioLabel(p)}`, `priority:${p}`))
  for (const id of _adv.tag) {
    const g = _allTags.find(x => x.id === id)
    chips.push(advChip(`Tag: ${g?.name || id}`, `tag:${id}`))
  }
  if (_adv.assigned_to) {
    const lbl = _adv.assigned_to === 'me' ? 'Moi' : _adv.assigned_to === 'unassigned' ? 'Non assigné' : _adv.assigned_to
    chips.push(advChip(`Assigné: ${lbl}`, 'assigned_to'))
  }
  if (_adv.created_from) chips.push(advChip(`Depuis: ${_adv.created_from}`, 'created_from'))
  if (_adv.created_to)   chips.push(advChip(`Jusqu'à: ${_adv.created_to}`, 'created_to'))
  if (chips.length) {
    el.style.display = 'flex'
    el.innerHTML = chips.join('')
  } else {
    el.style.display = 'none'
    el.innerHTML = ''
  }
}

function advChip(label, key) {
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-secondary);font-size:11px;padding:2px 8px;border-radius:10px">
    ${esc(label)} <span style="cursor:pointer;opacity:0.7;padding:8px;margin:-8px -4px -8px 0" onclick="mTkRemoveChip(${mJsArg(key)})">×</span>
  </span>`
}

function mTkRemoveChip(key) {
  if (key.startsWith('priority:')) {
    const p = key.split(':')[1]
    _adv.priority = _adv.priority.filter(x => x !== p)
  } else if (key.startsWith('tag:')) {
    const id = key.split(':')[1]
    _adv.tag = _adv.tag.filter(x => x !== id)
  } else if (key === 'assigned_to') {
    _adv.assigned_to = ''
  } else if (key === 'created_from') {
    _adv.created_from = ''
  } else if (key === 'created_to') {
    _adv.created_to = ''
  }
  loadTickets()
}

function mTkOpenFilters() {
  const prios = ['low', 'normal', 'high', 'critical']
  const html = `
    <div class="m-sheet-title">Filtres avancés</div>
    <div style="display:flex;flex-direction:column;gap:14px;padding:0 4px">
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">Priorité</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${prios.map(p => `
            <button class="m-filter-pill ${_adv.priority.includes(p)?'active':''}" data-pf="${p}">${prioLabel(p)}</button>
          `).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">Tags</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${_allTags.length ? _allTags.map(g => `
            <button class="m-filter-pill ${_adv.tag.includes(g.id)?'active':''}" data-tg="${g.id}"
              style="background:${_adv.tag.includes(g.id) ? (M_TAG_PALETTE[g.color] || M_TAG_PALETTE.slate) : ''};color:${_adv.tag.includes(g.id)?'#fff':''}">
              ${esc(g.name)}
            </button>`).join('') : '<span style="font-size:12px;color:var(--text-tertiary)">Aucun tag</span>'}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">Assigné</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          <button class="m-filter-pill ${_adv.assigned_to==='me'?'active':''}"          data-as="me">Moi</button>
          <button class="m-filter-pill ${_adv.assigned_to==='unassigned'?'active':''}" data-as="unassigned">Non assigné</button>
          <button class="m-filter-pill ${_adv.assigned_to===''?'active':''}"            data-as="">Tous</button>
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">${t('mobile.tickets.filters.dates')}</div>
        <div style="display:flex;gap:8px">
          <input type="date" class="m-input" id="m-tk-from" value="${esc(_adv.created_from)}" style="flex:1">
          <input type="date" class="m-input" id="m-tk-to"   value="${esc(_adv.created_to)}"   style="flex:1">
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="m-btn-primary" style="flex:1" onclick="mTkApplyAdv()">Appliquer</button>
        <button class="m-filter-pill" style="flex:1;text-align:center" onclick="mTkClearAdv()">Effacer</button>
      </div>
    </div>`
  window.mShowSheet(html)

  // Toggles internes
  setTimeout(() => {
    document.querySelectorAll('[data-pf]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.pf
        const i = _adv.priority.indexOf(p)
        if (i === -1) _adv.priority.push(p)
        else _adv.priority.splice(i, 1)
        btn.classList.toggle('active')
      })
    })
    document.querySelectorAll('[data-tg]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tg
        const i = _adv.tag.indexOf(id)
        if (i === -1) _adv.tag.push(id)
        else _adv.tag.splice(i, 1)
        btn.classList.toggle('active')
        const g = _allTags.find(x => x.id === id)
        if (btn.classList.contains('active')) {
          btn.style.background = M_TAG_PALETTE[g?.color] || M_TAG_PALETTE.slate
          btn.style.color = '#fff'
        } else {
          btn.style.background = ''
          btn.style.color = ''
        }
      })
    })
    document.querySelectorAll('[data-as]').forEach(btn => {
      btn.addEventListener('click', () => {
        _adv.assigned_to = btn.dataset.as
        document.querySelectorAll('[data-as]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
      })
    })
  }, 50)
}

function mTkApplyAdv() {
  // Lire les dates AVANT de fermer la sheet (mCloseSheet vide le DOM interne).
  _adv.created_from = document.getElementById('m-tk-from')?.value || ''
  _adv.created_to   = document.getElementById('m-tk-to')?.value   || ''
  window.mCloseSheet()
  loadTickets()
}

function mTkClearAdv() {
  _adv = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
  window.mCloseSheet()
  loadTickets()
}

// Valeur inconnue échappée : priority est du texte libre côté API.
function prioLabel(p) {
  return p === 'low' ? 'Basse' : p === 'normal' ? 'Normale' : p === 'high' ? 'Haute' : p === 'critical' ? 'Critique' : esc(p)
}
