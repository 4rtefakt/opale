// Vue Tickets — split layout liste / détail
// Filtres avancés (priorité, tags, assigné, dates) persistés dans le hash URL.

const TAG_PALETTE = {
  slate:  { bg: '#475569', fg: '#ffffff', label: 'Gris'    },
  blue:   { bg: '#2563eb', fg: '#ffffff', label: 'Bleu'    },
  green:  { bg: '#059669', fg: '#ffffff', label: 'Vert'    },
  amber:  { bg: '#d97706', fg: '#ffffff', label: 'Ambre'   },
  red:    { bg: '#dc2626', fg: '#ffffff', label: 'Rouge'   },
  violet: { bg: '#7c3aed', fg: '#ffffff', label: 'Violet'  },
  pink:   { bg: '#db2777', fg: '#ffffff', label: 'Rose'    },
  teal:   { bg: '#0d9488', fg: '#ffffff', label: 'Sarcelle'},
}
const TAG_COLOR_KEYS = Object.keys(TAG_PALETTE)

// jsArg() fourni globalement par app.js (window.jsArg)
const jsArg = window.jsArg

// "Christophe Germain" → "Christophe G."  ;  "Clément" → "Clément"
function shortName(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] || ''
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.'
}

// Affiche updated_at si différent de created_at (mode hybride), sinon created_at.
function displayWhen(tk) {
  if (!tk.updated_at || tk.updated_at === tk.created_at) {
    return formatRelative(tk.created_at)
  }
  return `${t('tickets.maj_prefix')} ${formatRelative(tk.updated_at)}`
}

// Petit point rouge devant un élément quand awaiting_reply est true
function awaitingDot(tk) {
  if (!tk.awaiting_reply) return ''
  return `<span title="${esc(t('tickets.awaiting_reply'))}" style="display:inline-block;width:8px;height:8px;background:var(--red);border-radius:50%;margin-right:6px;flex-shrink:0;vertical-align:middle"></span>`
}

let _tickets       = []
let _activeId      = null
let _allTags       = []          // référentiel complet
let _filters       = defaultFilters()
let _showAdvanced  = false
let _localQ        = ''          // recherche locale (titre/hostname)
let _view          = 'list'      // 'list' | 'kanban'
let _proposalsCount = 0

const KANBAN_COL_CAP = 30
const KANBAN_COLS    = ['open', 'in_progress', 'resolved']
const VIEW_LS_KEY    = 'opale.tickets.view'

// ─── View persistence : hash > localStorage > 'list' ────────────────────────

function readView() {
  const hash = window.location.hash || ''
  const qIdx = hash.indexOf('?')
  if (qIdx !== -1) {
    const v = new URLSearchParams(hash.slice(qIdx + 1)).get('view')
    if (v === 'kanban' || v === 'list') return v
  }
  try {
    const v = localStorage.getItem(VIEW_LS_KEY)
    if (v === 'kanban' || v === 'list') return v
  } catch {}
  return 'list'
}

function writeView(v) {
  try { localStorage.setItem(VIEW_LS_KEY, v) } catch {}
  // Reflète aussi dans le hash pour bookmark/partage
  const hash = window.location.hash || '#/tickets'
  const qIdx = hash.indexOf('?')
  const sp   = new URLSearchParams(qIdx === -1 ? '' : hash.slice(qIdx + 1))
  if (v === 'list') sp.delete('view')
  else              sp.set('view', v)
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx)
  const qs   = sp.toString()
  const newHash = qs ? `${path}?${qs}` : path
  if (newHash !== hash) history.replaceState(null, '', newHash)
}

function defaultFilters() {
  return {
    status: 'all',          // all | open | in_progress | auto | resolved
    priority: [],           // csv
    tag: [],                // csv tag_ids
    assigned_to: '',        // entra_id | 'me' | 'unassigned' | ''
    assigned_label: '',     // libellé picker (affichage)
    created_from: '',
    created_to: '',
  }
}

// ─── Hash sync ───────────────────────────────────────────────────────────────

function readFiltersFromHash() {
  const hash = window.location.hash || ''
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return defaultFilters()
  const sp = new URLSearchParams(hash.slice(qIdx + 1))
  const f = defaultFilters()
  if (sp.get('status'))       f.status   = sp.get('status')
  if (sp.get('priority'))     f.priority = sp.get('priority').split(',').filter(Boolean)
  if (sp.get('tag'))          f.tag      = sp.get('tag').split(',').filter(Boolean)
  if (sp.get('assigned_to'))  f.assigned_to = sp.get('assigned_to')
  if (sp.get('assigned_label'))  f.assigned_label = sp.get('assigned_label')
  if (sp.get('created_from')) f.created_from = sp.get('created_from')
  if (sp.get('created_to'))   f.created_to   = sp.get('created_to')
  return f
}

function writeFiltersToHash() {
  const sp = new URLSearchParams()
  if (_filters.status && _filters.status !== 'all') sp.set('status', _filters.status)
  if (_filters.priority.length)    sp.set('priority',    _filters.priority.join(','))
  if (_filters.tag.length)         sp.set('tag',         _filters.tag.join(','))
  if (_filters.assigned_to)        sp.set('assigned_to', _filters.assigned_to)
  if (_filters.assigned_label)     sp.set('assigned_label', _filters.assigned_label)
  if (_filters.created_from)       sp.set('created_from', _filters.created_from)
  if (_filters.created_to)         sp.set('created_to',   _filters.created_to)

  const hash    = window.location.hash || '#/tickets'
  const pathPart = hash.split('?')[0]
  const qs       = sp.toString()
  const newHash  = qs ? `${pathPart}?${qs}` : pathPart
  if (newHash !== hash) history.replaceState(null, '', newHash)
}

// Construit les paramètres pour l'API à partir des filtres
function filtersToParams() {
  const p = {}
  if (_filters.status === 'auto') {
    p.is_auto = 'true'
  } else if (_filters.status && _filters.status !== 'all') {
    p.status = _filters.status
  }
  if (_filters.priority.length)    p.priority    = _filters.priority.join(',')
  if (_filters.tag.length)         p.tag         = _filters.tag.join(',')
  if (_filters.assigned_to)        p.assigned_to = _filters.assigned_to
  if (_filters.created_from)       p.created_from = _filters.created_from
  if (_filters.created_to)         p.created_to   = _filters.created_to
  return p
}

// ─── Render principal ────────────────────────────────────────────────────────

export async function renderTickets(container, opts = {}) {
  // Capture l'intent du deep-link `?new=true&device=<id>` AVANT toute
  // logique de render. Sinon, si `_activeId` était set par une visite
  // précédente (module-scoped), `selectTicket` se déclenche pendant
  // `renderMain` et réécrit `window.location.hash` via replaceState
  // — on perd le `?…` avant d'avoir pu le parser.
  let pendingNewModal = null
  const initialQs = (window.location.hash || '').split('?')[1]
  if (initialQs) {
    const params = new URLSearchParams(initialQs)
    if (params.get('new') === 'true') {
      pendingNewModal = { deviceId: params.get('device') }
      // Reset : on ne veut pas ouvrir un ticket en arrière-plan derrière
      // la modale de création.
      _activeId = null
    }
  }

  // Deep-link : `#/tickets/<id>` ouvre directement ce ticket (partageable).
  // Cf. router app.js qui passe parts[1] en `ticketId`.
  if (opts.ticketId) _activeId = opts.ticketId

  _filters      = readFiltersFromHash()
  _showAdvanced = hasActiveAdvanced()
  _view         = readView()

  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('tickets.title')}</h1>
      <div class="topbar-actions">
        <div class="btn-group" style="display:inline-flex;border-radius:6px;overflow:hidden">
          <button class="btn btn-sm ${_view==='list'?'btn-primary':''}"   onclick="tkSetView('list')"   title="${t('tickets.view.list')}"><i class="ti ti-list"></i></button>
          <button class="btn btn-sm ${_view==='kanban'?'btn-primary':''}" onclick="tkSetView('kanban')" title="${t('tickets.view.kanban')}"><i class="ti ti-layout-kanban"></i></button>
        </div>
        <button class="btn" id="tk-proposals-btn" style="display:none" onclick="openProposalsModal()" title="${t('tickets.proposals.title')}">
          <i class="ti ti-bulb"></i> ${t('tickets.proposals.title')}
          <span id="tk-proposals-count" class="badge" style="margin-left:6px;background:var(--red);color:#fff;padding:0 6px;border-radius:10px;font-size:11px"></span>
        </button>
        <button class="btn" onclick="openTagsModal()" title="${t('tickets.tags.manage')}">
          <i class="ti ti-tags"></i> ${t('tickets.tags.manage')}
        </button>
        <button class="btn btn-primary" onclick="openNewTicketModal()">
          <i class="ti ti-plus"></i> ${t('btn.new_ticket')}
        </button>
      </div>
    </div>
    <div id="tk-main" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`

  ensureKanbanStyles()

  window.filterTickets        = filterTickets
  window.setStatusFilter      = setStatusFilter
  window.toggleAdvanced       = toggleAdvanced
  window.openNewTicketModal   = openNewTicketModal
  window.openTagsModal        = openTagsModal
  window.selectTicket         = selectTicket
  window.sendReply            = sendReply
  window.resolveTicket        = resolveTicket
  window.reopenTicket         = reopenTicket
  window.tkSetPriorityFilter  = tkSetPriorityFilter
  window.tkToggleTagFilter    = tkToggleTagFilter
  window.tkSetAssignedFilter  = tkSetAssignedFilter
  window.tkSetDateFilter      = tkSetDateFilter
  window.tkClearFilters       = tkClearFilters
  window.tkRemoveChip         = tkRemoveChip
  window.tkOpenAssignedPicker = tkOpenAssignedPicker
  window.tkOpenTagPicker      = tkOpenTagPicker
  window.tkRemoveTagFromTicket = tkRemoveTagFromTicket
  window.tkAssignSelf         = tkAssignSelf
  window.tkUnassign           = tkUnassign
  window.tkOpenAssigneePickerOnTicket = tkOpenAssigneePickerOnTicket
  window.tkOpenRequesterPicker = tkOpenRequesterPicker
  window.tkClearRequester      = tkClearRequester
  window.tkOpenDevicePicker    = tkOpenDevicePicker
  window.tkClearDevice         = tkClearDevice
  window.openProposalsModal    = openProposalsModal
  window.tkAcceptProposal      = tkAcceptProposal
  window.tkRejectProposal      = tkRejectProposal
  window.tkSetView            = tkSetView
  window.tkOpenDrawer         = tkOpenDrawer
  window.tkCloseDrawer        = tkCloseDrawer
  window.tkKanbanDragStart    = tkKanbanDragStart
  window.tkKanbanDragOver     = tkKanbanDragOver
  window.tkKanbanDragLeave    = tkKanbanDragLeave
  window.tkKanbanDrop         = tkKanbanDrop
  window.tkKanbanGotoList     = tkKanbanGotoList

  // Précharge le référentiel tags en parallèle de la liste
  await Promise.all([loadTags(), loadTickets(), loadProposalsCount()])
  renderMain()

  // Deep-link create : ouvrir la modale moderne avec le device pré-rempli.
  // L'intent a été capturé au tout début de renderTickets (cf. plus haut)
  // pour ne pas se faire écraser par un replaceState éventuel de selectTicket.
  if (pendingNewModal) {
    let prefillDevice = null
    if (pendingNewModal.deviceId) {
      try {
        const dev = await window.api.getDevice(pendingNewModal.deviceId)
        if (dev?.id) prefillDevice = { id: dev.id, hostname: dev.hostname }
      } catch {}
    }
    // Nettoie l'URL pour éviter la réouverture au refresh.
    history.replaceState(null, '', '#/tickets')
    openNewTicketModal({ prefillDevice })
  }
}

async function loadProposalsCount() {
  try {
    const { pending } = await window.api.getProposalsCount()
    _proposalsCount = pending || 0
  } catch { _proposalsCount = 0 }
  updateProposalsBadge()
}

function updateProposalsBadge() {
  const btn = document.getElementById('tk-proposals-btn')
  const cnt = document.getElementById('tk-proposals-count')
  if (!btn || !cnt) return
  if (_proposalsCount > 0) {
    btn.style.display = ''
    cnt.textContent = _proposalsCount
  } else {
    btn.style.display = 'none'
    cnt.textContent = ''
  }
}

// ─── Render principal selon _view ───────────────────────────────────────────

function renderMain() {
  const main = document.getElementById('tk-main')
  if (!main) return
  if (_view === 'kanban') {
    renderKanbanLayout(main)
  } else {
    renderListLayout(main)
  }
  renderAdvancedPanel()
  renderActiveChips()
}

function renderListLayout(main) {
  main.innerHTML = `
    <div class="view-split" style="flex:1;min-height:0">
      <div class="ticket-list-col">
        <div class="toolbar" style="padding:8px 10px;gap:6px;border-bottom:0.5px solid var(--border)">
          <input class="search-input" id="tk-q" placeholder="${t('tickets.search')}"
            oninput="filterTickets(this.value)" style="flex:1;min-width:0" value="${esc(_localQ)}">
          <button class="btn btn-sm" id="tk-adv-toggle" onclick="toggleAdvanced()" title="${t('tickets.filters.advanced')}">
            <i class="ti ti-filter"></i>
          </button>
        </div>
        <div class="toolbar" style="padding:6px 10px;border-bottom:0.5px solid var(--border);gap:4px;flex-wrap:nowrap">
          ${['all','open','in_progress','auto','resolved'].map(s => `
            <button class="btn btn-sm ${_filters.status===s?'btn-primary':''}" id="tf-${s}"
              onclick="setStatusFilter('${s}')">${t('tickets.filter.'+s)}</button>
          `).join('')}
        </div>
        <div id="tk-adv-panel" style="display:${_showAdvanced?'block':'none'};border-bottom:0.5px solid var(--border);padding:8px 10px;background:var(--bg-secondary)"></div>
        <div id="tk-active-chips" style="padding:6px 10px;border-bottom:0.5px solid var(--border);display:none;flex-wrap:wrap;gap:4px"></div>
        <div class="ticket-list-scroll" id="ticket-list"></div>
      </div>
      <div class="ticket-detail-col" id="ticket-detail">
        <div class="ticket-detail-empty">
          <i class="ti ti-ticket" style="font-size:32px"></i>
          <span>${t('tickets.select_hint')}</span>
        </div>
      </div>
    </div>`
  renderList()
  // Si un ticket était actif (par ex. après fermeture du drawer Kanban), le re-charger
  if (_activeId) selectTicket(_activeId)
}

function renderKanbanLayout(main) {
  main.innerHTML = `
    <div class="view-kanban" style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="toolbar" style="padding:8px 12px;gap:6px;border-bottom:0.5px solid var(--border)">
        <input class="search-input" id="tk-q" placeholder="${t('tickets.search')}"
          oninput="filterTickets(this.value)" style="flex:1;min-width:0;max-width:360px" value="${esc(_localQ)}">
        <button class="btn btn-sm" id="tk-adv-toggle" onclick="toggleAdvanced()" title="${t('tickets.filters.advanced')}">
          <i class="ti ti-filter"></i>
        </button>
      </div>
      <div id="tk-adv-panel" style="display:${_showAdvanced?'block':'none'};border-bottom:0.5px solid var(--border);padding:8px 12px;background:var(--bg-secondary)"></div>
      <div id="tk-active-chips" style="padding:6px 12px;border-bottom:0.5px solid var(--border);display:none;flex-wrap:wrap;gap:4px"></div>
      <div class="kanban-board" style="flex:1;display:grid;grid-template-columns:repeat(3, 1fr);gap:10px;padding:10px;overflow:auto;min-height:0">
        ${KANBAN_COLS.map(s => `
          <div class="kanban-col" data-status="${s}"
               ondragover="tkKanbanDragOver(event)"
               ondragleave="tkKanbanDragLeave(event)"
               ondrop="tkKanbanDrop(event,'${s}')">
            <div class="kanban-col-header">
              <span>${kanbanColLabel(s)}</span>
              <span class="kanban-col-count" id="kc-count-${s}">0</span>
            </div>
            <div class="kanban-col-body" id="kc-body-${s}"></div>
          </div>
        `).join('')}
      </div>
    </div>`
  renderKanbanCards()
  // Deep-link sur kanban : si on arrive sur `/tickets/<id>`, ouvrir le drawer.
  if (_activeId) tkOpenDrawer(_activeId)
}

// ─── Kanban : remplit les colonnes ───────────────────────────────────────────

function renderKanbanCards() {
  // Filtre local (search bar)
  const lower = _localQ.toLowerCase()
  const visible = _localQ
    ? _tickets.filter(tk => tk.title.toLowerCase().includes(lower) ||
                            (tk.hostname || '').toLowerCase().includes(lower))
    : _tickets

  const groups = { open: [], in_progress: [], resolved: [] }
  for (const tk of visible) {
    if (groups[tk.status]) groups[tk.status].push(tk)
    // les statuts hors-norme (proposed, etc.) sont ignorés en Kanban
  }

  for (const s of KANBAN_COLS) {
    const body  = document.getElementById('kc-body-' + s)
    const count = document.getElementById('kc-count-' + s)
    if (!body || !count) continue
    const list = groups[s]
    count.textContent = list.length
    const shown = list.slice(0, KANBAN_COL_CAP)
    const overflow = list.length - shown.length
    body.innerHTML = shown.map(tk => kanbanCard(tk)).join('') +
      (overflow > 0
        ? `<div class="kanban-overflow"><span>${t('tickets.kanban.more').replace('{n}', overflow)}</span>
            <button class="btn btn-sm" onclick="tkKanbanGotoList('${s}')">${t('tickets.kanban.see_all')}</button>
           </div>`
        : '')
    if (!list.length) {
      body.innerHTML = `<div class="kanban-empty">${t('tickets.kanban.empty')}</div>`
    }
  }
}

function kanbanCard(tk) {
  const prioColor = tk.priority === 'critical' ? '#dc2626'
                  : tk.priority === 'high'     ? '#d97706'
                  : tk.priority === 'low'      ? '#64748b'
                  : '#0d9488'
  const tags = (tk.tags || []).slice(0, 4).map(g => tagChip(g, { compact: true })).join('')
  return `
    <div class="kanban-card" draggable="true"
         ondragstart="tkKanbanDragStart(event,'${tk.id}')"
         onclick="tkOpenDrawer('${tk.id}')">
      <div class="kc-prio" style="background:${prioColor}"></div>
      <div class="kc-body">
        <div class="kc-title">${awaitingDot(tk)}${esc(tk.title)}</div>
        ${tags ? `<div class="kc-tags">${tags}</div>` : ''}
        <div class="kc-meta">
          ${tk.is_auto ? `<span class="kc-badge kc-badge-auto" title="Auto"><i class="ti ti-robot" style="font-size:10px"></i></span>` : ''}
          ${tk.requester_name ? `<span class="kc-badge" title="${esc(t('tickets.info.requester'))}: ${esc(tk.requester_name)}"><i class="ti ti-user" style="font-size:10px"></i> ${esc(shortName(tk.requester_name))}</span>` : ''}
          ${tk.assigned_to_name ? `<span class="kc-badge" title="${esc(t('tickets.info.assignee'))}: ${esc(tk.assigned_to_name)}"><i class="ti ti-user-check" style="font-size:10px"></i> ${esc(shortName(tk.assigned_to_name))}</span>` : (!['resolved'].includes(tk.status) ? `<span class="kc-badge kc-badge-unassigned"><i class="ti ti-user-off" style="font-size:10px"></i> ${esc(t('tickets.unassigned'))}</span>` : '')}
          ${tk.hostname ? `<span class="kc-badge" title="Poste"><i class="ti ti-device-laptop" style="font-size:10px"></i> ${esc(tk.hostname)}</span>` : ''}
        </div>
        <div class="kc-time">${displayWhen(tk)}</div>
      </div>
    </div>`
}

function kanbanColLabel(s) {
  return s === 'open'        ? t('tickets.status.open')
       : s === 'in_progress' ? t('tickets.status.in_progress')
       : s === 'resolved'    ? t('tickets.status.resolved')
       : s
}

// ─── Toggle vue ─────────────────────────────────────────────────────────────

async function tkSetView(v) {
  if (v === _view) return
  _view = v
  writeView(v)
  // Re-render uniquement la zone main (pas de re-fetch)
  // Mettre à jour les boutons toggle
  document.querySelectorAll('.topbar-actions .btn-group .btn').forEach((btn, i) => {
    const target = i === 0 ? 'list' : 'kanban'
    btn.classList.toggle('btn-primary', target === v)
  })
  if (v !== 'kanban') tkCloseDrawer()
  renderMain()
}

// "Voir tout" depuis une colonne Kanban → bascule liste avec ce statut filtré
async function tkKanbanGotoList(status) {
  _filters.status = status
  writeFiltersToHash()
  _view = 'list'
  writeView('list')
  document.querySelectorAll('.topbar-actions .btn-group .btn').forEach((btn, i) => {
    btn.classList.toggle('btn-primary', i === 0)
  })
  renderMain()
}

// ─── Drag & drop ─────────────────────────────────────────────────────────────

function tkKanbanDragStart(e, ticketId) {
  e.dataTransfer.setData('text/plain', ticketId)
  e.dataTransfer.effectAllowed = 'move'
  e.currentTarget?.classList.add('kc-dragging')
}

function tkKanbanDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const col = e.currentTarget
  if (col?.classList && !col.classList.contains('kanban-col-hover')) {
    col.classList.add('kanban-col-hover')
  }
}

function tkKanbanDragLeave(e) {
  e.currentTarget?.classList.remove('kanban-col-hover')
}

async function tkKanbanDrop(e, newStatus) {
  e.preventDefault()
  e.currentTarget?.classList.remove('kanban-col-hover')
  document.querySelectorAll('.kc-dragging').forEach(el => el.classList.remove('kc-dragging'))

  const ticketId = e.dataTransfer.getData('text/plain')
  if (!ticketId) return
  const tk = _tickets.find(t => t.id === ticketId)
  if (!tk || tk.status === newStatus) return

  const oldStatus = tk.status
  // Optimistic update : on déplace en mémoire et on re-render
  tk.status = newStatus
  if (newStatus === 'resolved') tk.resolved_at = new Date().toISOString()
  renderKanbanCards()

  try {
    const updated = await window.api.updateTicket(ticketId, { status: newStatus })
    Object.assign(tk, updated, { tags: tk.tags })  // garde les tags chargés
  } catch {
    // Rollback
    tk.status = oldStatus
    if (oldStatus !== 'resolved') tk.resolved_at = null
    renderKanbanCards()
    showToast(t('error.generic'), 'error')
  }
}

// ─── Drawer latéral droit ────────────────────────────────────────────────────

async function tkOpenDrawer(ticketId) {
  _activeId = ticketId
  // Cohérence avec selectTicket : URL partageable même en mode kanban.
  const expected = `#/tickets/${ticketId}`
  if (window.location.hash !== expected) {
    try { history.replaceState(null, '', expected) } catch {}
  }
  let drawer = document.getElementById('ticket-drawer')
  if (!drawer) {
    drawer = document.createElement('div')
    drawer.id = 'ticket-drawer'
    drawer.innerHTML = `
      <div class="td-header">
        <button class="btn btn-sm" onclick="tkCloseDrawer()" title="${t('btn.cancel')}">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <div class="td-content" id="ticket-drawer-content">
        <div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div>
      </div>`
    document.body.appendChild(drawer)
    // Click hors drawer → ferme
    document.addEventListener('click', drawerOutsideClick, true)
    document.addEventListener('keydown', drawerEscHandler)
  }
  drawer.classList.add('open')

  try {
    const tk = await window.api.getTicket(ticketId)
    renderDetail(tk, document.getElementById('ticket-drawer-content'))
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function tkCloseDrawer() {
  const drawer = document.getElementById('ticket-drawer')
  if (drawer) drawer.classList.remove('open')
  _activeId = null
  // Nettoie l'URL si on était arrivé par un deep-link `/tickets/<id>`.
  if (window.location.hash !== '#/tickets') {
    try { history.replaceState(null, '', '#/tickets') } catch {}
  }
}

function drawerOutsideClick(e) {
  const drawer = document.getElementById('ticket-drawer')
  if (!drawer || !drawer.classList.contains('open')) return
  // Ne pas fermer si click dans le drawer ou dans une modal qui chevauche
  if (drawer.contains(e.target)) return
  if (e.target.closest('#modal-overlay')) return
  // Ne pas fermer si click sur une carte Kanban (qui ouvrirait un autre ticket)
  if (e.target.closest('.kanban-card')) return
  tkCloseDrawer()
}

function drawerEscHandler(e) {
  if (e.key === 'Escape') {
    const drawer = document.getElementById('ticket-drawer')
    if (drawer?.classList.contains('open')) tkCloseDrawer()
  }
}

// ─── Styles Kanban + Drawer (injectés une fois) ──────────────────────────────

function ensureKanbanStyles() {
  if (document.getElementById('kanban-styles')) return
  const s = document.createElement('style')
  s.id = 'kanban-styles'
  s.textContent = `
    .kanban-col { display:flex; flex-direction:column; background:var(--bg-secondary); border:0.5px solid var(--border); border-radius:8px; min-height:0; overflow:hidden; transition: background 0.15s; }
    .kanban-col-hover { background:var(--bg-tertiary); outline:2px dashed var(--blue); outline-offset:-4px; }
    .kanban-col-header { padding:8px 12px; border-bottom:0.5px solid var(--border); display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-secondary); background:var(--bg-primary); }
    .kanban-col-count { background:var(--bg-tertiary); color:var(--text-secondary); padding:1px 8px; border-radius:10px; font-size:11px; font-weight:500; }
    .kanban-col-body { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
    .kanban-empty { color:var(--text-tertiary); font-size:12px; text-align:center; padding:20px 8px; }
    .kanban-overflow { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; font-size:11px; color:var(--text-tertiary); }
    .kanban-card { background:var(--bg-primary); border:0.5px solid var(--border); border-radius:6px; cursor:pointer; display:flex; overflow:hidden; transition: box-shadow 0.15s; }
    .kanban-card:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.08); border-color: var(--blue); }
    .kanban-card.kc-dragging { opacity:0.4; }
    .kc-prio { width:3px; flex-shrink:0; }
    .kc-body { flex:1; padding:8px 10px; display:flex; flex-direction:column; gap:4px; min-width:0; }
    .kc-title { font-size:13px; font-weight:500; line-height:1.3; word-wrap:break-word; }
    .kc-tags { display:flex; gap:3px; flex-wrap:wrap; }
    .kc-meta { display:flex; gap:4px; flex-wrap:wrap; }
    .kc-badge { display:inline-flex; align-items:center; gap:3px; background:var(--bg-secondary); color:var(--text-secondary); font-size:10px; padding:1px 6px; border-radius:8px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .kc-badge-auto { color:var(--blue); }
    .kc-badge-unassigned { color:var(--text-tertiary); font-style:italic; }
    .kc-time { font-size:10px; color:var(--text-tertiary); }

    #ticket-drawer { position:fixed; top:0; right:0; bottom:0; width:min(460px, 92vw); background:var(--bg-primary); border-left:0.5px solid var(--border); box-shadow:-4px 0 16px rgba(0,0,0,0.08); transform:translateX(100%); transition: transform 0.18s ease-out; z-index:50; display:flex; flex-direction:column; }
    #ticket-drawer.open { transform:translateX(0); }
    #ticket-drawer .td-header { padding:8px 12px; border-bottom:0.5px solid var(--border); display:flex; justify-content:flex-end; align-items:center; flex-shrink:0; }
    #ticket-drawer .td-content { flex:1; overflow:hidden; display:flex; flex-direction:column; }
    /* Override du body-grid (2 cols → 1 col empilée) pour tenir dans 460px */
    #ticket-drawer .ticket-body-grid { display:flex !important; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
    #ticket-drawer .ticket-thread-col { order:2; border-right:none; border-top:0.5px solid var(--border); flex:1; min-height:0; }
    #ticket-drawer .ticket-info-col   { order:1; flex-shrink:0; max-height:40vh; overflow-y:auto; padding:12px 16px; }
  `
  document.head.appendChild(s)
}

async function loadTags() {
  try { _allTags = await window.api.getTags() } catch { _allTags = [] }
}

async function loadTickets() {
  try {
    _tickets = await window.api.getTickets(filtersToParams())
    renderListOrKanban()
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function renderListOrKanban() {
  if (_view === 'kanban') renderKanbanCards()
  else                    renderList()
}

// ─── Liste ───────────────────────────────────────────────────────────────────

function renderList() {
  const el = document.getElementById('ticket-list')
  if (!el) return
  const lower = _localQ.toLowerCase()
  const filtered = _localQ
    ? _tickets.filter(tk => tk.title.toLowerCase().includes(lower) ||
                             (tk.hostname || '').toLowerCase().includes(lower))
    : _tickets

  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem"><i class="ti ti-ticket"></i><p>${t('tickets.empty')}</p></div>`
    return
  }
  el.innerHTML = filtered.map(tk => ticketItem(tk)).join('')
}

function ticketItem(tk) {
  const status = statusLabel(tk.status)
  const prio   = prioLabel(tk.priority)
  const active = _activeId === tk.id ? ' active' : ''
  const tagsHtml = (tk.tags || []).slice(0, 4).map(g => tagChip(g, { compact: true })).join('')
  return `
    <div class="ticket-item${active}" onclick="selectTicket('${tk.id}')">
      <div class="tk-header">
        <span class="tk-title">${awaitingDot(tk)}${esc(tk.title)}</span>
        <span class="badge badge-${tk.status==='resolved'?'green':tk.status==='in_progress'?'blue':'orange'}">${status}</span>
      </div>
      <div class="tk-meta">
        <span>${prio}</span>
        ${tk.hostname ? `<span>· ${esc(tk.hostname)}</span>` : ''}
        ${tk.requester_name ? `<span title="${esc(t('tickets.info.requester'))}: ${esc(tk.requester_name)}">· <i class="ti ti-user" style="font-size:11px;opacity:0.7"></i> ${esc(shortName(tk.requester_name))}</span>` : ''}
        ${tk.assigned_to_name ? `<span title="${esc(t('tickets.info.assignee'))}: ${esc(tk.assigned_to_name)}">· <i class="ti ti-user-check" style="font-size:11px;opacity:0.7"></i> ${esc(shortName(tk.assigned_to_name))}</span>` : ''}
        <span>· ${displayWhen(tk)}</span>
      </div>
      ${tagsHtml ? `<div class="tk-tags" style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">${tagsHtml}</div>` : ''}
    </div>`
}

function tagChip(tag, opts = {}) {
  const palette = TAG_PALETTE[tag.color] || TAG_PALETTE.slate
  const size = opts.compact
    ? 'font-size:10px;padding:1px 6px;border-radius:8px'
    : 'font-size:11px;padding:2px 8px;border-radius:10px'
  const closeBtn = opts.onRemove
    ? ` <span style="margin-left:4px;cursor:pointer;opacity:0.85" onclick="event.stopPropagation();${opts.onRemove}">×</span>`
    : ''
  return `<span style="display:inline-flex;align-items:center;background:${palette.bg};color:${palette.fg};${size}">${esc(tag.name)}${closeBtn}</span>`
}

// ─── Détail ──────────────────────────────────────────────────────────────────

async function selectTicket(id) {
  _activeId = id
  // Met à jour l'URL pour partage (#/tickets/<id>). replaceState ne
  // déclenche pas hashchange — pas de re-render du router.
  const expected = `#/tickets/${id}`
  if (window.location.hash !== expected) {
    try { history.replaceState(null, '', expected) } catch {}
  }
  renderList()
  const detail = document.getElementById('ticket-detail')
  detail.innerHTML = `<div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div>`
  try {
    const tk = await window.api.getTicket(id)
    renderDetail(tk)
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function getDetailContainer() {
  if (_view === 'kanban') return document.getElementById('ticket-drawer-content')
  return document.getElementById('ticket-detail')
}

function renderDetail(tk, container) {
  const detail = container || getDetailContainer()
  if (!detail) return
  const resolved = tk.status === 'resolved'
  detail.innerHTML = `
    <div class="ticket-detail-header">
      <div style="flex:1;min-width:0">
        <div class="ticket-detail-title">${esc(tk.title)}</div>
        <div class="ticket-detail-tags">
          <span class="badge badge-${tk.status==='resolved'?'green':tk.status==='in_progress'?'blue':'orange'}">${statusLabel(tk.status)}</span>
          <span class="badge">${prioLabel(tk.priority)}</span>
          ${tk.is_auto ? `<span class="badge">Auto</span>` : ''}
          ${tk.hostname ? `<span class="badge">${esc(tk.hostname)}</span>` : ''}
        </div>
      </div>
      <div class="ticket-detail-actions">
        ${!resolved ? `
          <button class="btn btn-sm" onclick="resolveTicket('${tk.id}')">${t('tickets.resolve')}</button>
        ` : `
          <button class="btn btn-sm" onclick="reopenTicket('${tk.id}')">${t('tickets.reopen')}</button>
        `}
      </div>
    </div>
    <div class="ticket-body-grid">
      <div class="ticket-thread-col">
        ${tk.description ? `<div class="desc-box">${esc(tk.description)}</div>` : ''}
        <div class="messages" id="msg-thread">
          ${tk.messages.map(m => renderMsg(m)).join('')}
        </div>
        ${!resolved ? `
          <div class="reply-box">
            <textarea class="reply-input" id="reply-input" placeholder="${t('tickets.reply_placeholder')}"></textarea>
            <div class="reply-actions">
              <button class="btn btn-primary btn-sm" onclick="sendReply('${tk.id}')">${t('tickets.send')}</button>
            </div>
          </div>
        ` : ''}
      </div>
      <div class="ticket-info-col">
        <div class="info-section">
          <div class="info-section-title">${t('tickets.info.details')}</div>
          <div class="info-row"><span class="label">${t('tickets.info.created')}</span><span class="value">${formatRelative(tk.created_at)}</span></div>
          ${tk.created_by_name ? `<div class="info-row"><span class="label">${t('tickets.info.by')}</span><span class="value">${esc(tk.created_by_name)}</span></div>` : ''}
          ${tk.updated_at ? `<div class="info-row"><span class="label">${t('tickets.info.updated')}</span><span class="value">${formatRelative(tk.updated_at)}</span></div>` : ''}
          ${resolved && tk.resolved_at ? `<div class="info-row"><span class="label">${t('tickets.info.resolved')}</span><span class="value">${formatRelative(tk.resolved_at)}</span></div>` : ''}
        </div>

        <div class="info-section">
          <div class="info-section-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>${t('tickets.info.assignee')}</span>
            <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkOpenAssigneePickerOnTicket('${tk.id}')">
              <i class="ti ti-pencil" style="font-size:11px"></i>
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="font-size:13px">${tk.assigned_to_name ? esc(tk.assigned_to_name) : `<span style="color:var(--text-tertiary)">${t('tickets.unassigned')}</span>`}</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkAssignSelf('${tk.id}')">${t('tickets.assign_self')}</button>
              ${tk.assigned_to_entra_id ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkUnassign('${tk.id}')">${t('tickets.unassign')}</button>` : ''}
            </div>
          </div>
        </div>

        <div class="info-section">
          <div class="info-section-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>${t('tickets.info.requester')}</span>
            <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkOpenRequesterPicker('${tk.id}')">
              <i class="ti ti-pencil" style="font-size:11px"></i>
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="font-size:13px">${tk.requester_name ? esc(tk.requester_name) : `<span style="color:var(--text-tertiary)">${t('tickets.no_requester')}</span>`}</div>
            ${tk.requester_email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(tk.requester_email)}</div>` : ''}
            ${tk.user_id ? `<div><button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkClearRequester('${tk.id}')">${t('tickets.clear_requester')}</button></div>` : ''}
          </div>
        </div>

        <div class="info-section">
          <div class="info-section-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>${t('tickets.info.tags')}</span>
            <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkOpenTagPicker('${tk.id}')">
              <i class="ti ti-plus" style="font-size:11px"></i> ${t('tickets.add_tag')}
            </button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${(tk.tags || []).length
              ? tk.tags.map(g => tagChip(g, { onRemove: `tkRemoveTagFromTicket('${tk.id}','${g.id}')` })).join('')
              : `<span style="color:var(--text-tertiary);font-size:12px">${t('tickets.no_tags')}</span>`}
          </div>
        </div>

        ${window.OPALE.moduleEnabled('inventory') ? `
        <div class="info-section">
          <div class="info-section-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>${t('tickets.info.device')}</span>
            <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkOpenDevicePicker('${tk.id}')">
              <i class="ti ti-pencil" style="font-size:11px"></i>
            </button>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="font-size:13px">${tk.hostname ? esc(tk.hostname) : `<span style="color:var(--text-tertiary)">${t('tickets.no_device')}</span>`}</div>
            ${tk.device_id ? `<div><button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="tkClearDevice('${tk.id}')">${t('tickets.clear_device')}</button></div>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>`

  const thread = document.getElementById('msg-thread')
  if (thread) thread.scrollTop = thread.scrollHeight
}

function renderMsg(m) {
  if (m.type === 'system') {
    return `<div class="msg">
      <div class="msg-av" style="background:var(--bg-tertiary);color:var(--text-tertiary)"><i class="ti ti-info-circle" style="font-size:14px"></i></div>
      <div class="msg-bubble">
        <div class="msg-author">${esc(m.author)}<span class="msg-time">${formatRelative(m.created_at)}</span></div>
        <div class="msg-content sys">${esc(m.content)}</div>
      </div>
    </div>`
  }
  const initials = (m.author || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  return `<div class="msg">
    <div class="msg-av">${esc(initials)}</div>
    <div class="msg-bubble">
      <div class="msg-author">${esc(m.author)}<span class="msg-time">${formatRelative(m.created_at)}</span></div>
      <div class="msg-content ${m.type === 'resolution' ? 'resolution' : ''}">${esc(m.content)}</div>
    </div>
  </div>`
}

// ─── Actions sur ticket ──────────────────────────────────────────────────────

async function sendReply(id) {
  const input = document.getElementById('reply-input')
  const content = input?.value?.trim()
  if (!content) return
  try {
    await window.api.addMessage(id, { content })
    input.value = ''
    const tk = await window.api.getTicket(id)
    renderDetail(tk)
    const idx = _tickets.findIndex(t => t.id === id)
    if (idx !== -1) { _tickets[idx].updated_at = new Date().toISOString(); renderList() }
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

async function resolveTicket(id) {
  try {
    await window.api.updateTicket(id, { status: 'resolved' })
    const tk = await window.api.getTicket(id)
    const idx = _tickets.findIndex(t => t.id === id)
    if (idx !== -1) { _tickets[idx].status = 'resolved'; _tickets[idx].resolved_at = tk.resolved_at }
    renderListOrKanban()
    renderDetail(tk)
    showToast(t('tickets.toast.resolved'), 'success')
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

async function reopenTicket(id) {
  try {
    await window.api.updateTicket(id, { status: 'open' })
    const tk = await window.api.getTicket(id)
    const idx = _tickets.findIndex(t => t.id === id)
    if (idx !== -1) { _tickets[idx].status = 'open'; _tickets[idx].resolved_at = null }
    renderListOrKanban()
    renderDetail(tk)
    showToast(t('tickets.toast.reopened'), 'info')
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

async function tkAssignSelf(id) {
  const me = window.appState?.user
  if (!me?.entraId) return
  try {
    await window.api.updateTicket(id, {
      assigned_to_entra_id: me.entraId,
      assigned_to_name: me.displayName,
    })
    await refreshTicket(id)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkUnassign(id) {
  try {
    await window.api.updateTicket(id, {
      assigned_to_entra_id: null,
      assigned_to_name: null,
    })
    await refreshTicket(id)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkOpenAssigneePickerOnTicket(id) {
  showModal(`
    <div class="modal-title">${t('tickets.assignee.picker_title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="tk-assignee-q" placeholder="${t('tickets.assignee.search')}" autocomplete="off">
      <div id="tk-assignee-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
  const input = document.getElementById('tk-assignee-q')
  const list  = document.getElementById('tk-assignee-results')
  setTimeout(() => input?.focus(), 50)

  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        list.innerHTML = users.length
          ? users.map(u => `
              <div class="user-row" style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                onclick="window.tkPickAssignee('${u.entra_id}', ${jsArg(u.display_name)})">
                <div style="font-size:13px">${esc(u.display_name)}</div>
                ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
              </div>`).join('')
          : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
      } catch { list.innerHTML = '' }
    }, 200)
  })

  window.tkPickAssignee = async (entraId, name) => {
    closeModal()
    try {
      await window.api.updateTicket(id, { assigned_to_entra_id: entraId, assigned_to_name: name })
      await refreshTicket(id)
    } catch { showToast(t('error.generic'), 'error') }
  }
}

async function tkOpenRequesterPicker(id) {
  showModal(`
    <div class="modal-title">${t('tickets.requester.picker_title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="tk-req-q" placeholder="${t('tickets.requester.search')}" autocomplete="off">
      <div id="tk-req-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
  const input = document.getElementById('tk-req-q')
  const list  = document.getElementById('tk-req-results')
  setTimeout(() => input?.focus(), 50)

  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        list.innerHTML = users.length
          ? users.map(u => `
              <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                onclick="window.tkPickRequester('${u.entra_id}')">
                <div style="font-size:13px">${esc(u.display_name)}</div>
                ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
              </div>`).join('')
          : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
      } catch { list.innerHTML = '' }
    }, 200)
  })

  window.tkPickRequester = async (entraId) => {
    closeModal()
    try {
      await window.api.updateTicket(id, { user_id: entraId })
      await refreshTicket(id)
    } catch { showToast(t('error.generic'), 'error') }
  }
}

async function tkOpenDevicePicker(id) {
  showModal(`
    <div class="modal-title">${t('tickets.device.picker_title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="tk-dev-q" placeholder="${t('tickets.device.search')}" autocomplete="off">
      <div id="tk-dev-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
  const input = document.getElementById('tk-dev-q')
  const list  = document.getElementById('tk-dev-results')
  setTimeout(() => input?.focus(), 50)

  // Charge tous les devices au premier render. getDevices retourne
  // { devices, total, thresholds } — déballer pour avoir le tableau plat.
  let devices = []
  try { devices = (await window.api.getDevices({ limit: 200 }))?.devices || [] } catch { devices = [] }
  const renderDevList = () => {
    const q = input.value.trim().toLowerCase()
    const filtered = q
      ? devices.filter(d => (d.hostname || '').toLowerCase().includes(q) ||
                            (d.user_name || '').toLowerCase().includes(q) ||
                            (d.model || '').toLowerCase().includes(q))
      : devices.slice(0, 50)
    list.innerHTML = filtered.length
      ? filtered.map(d => `
          <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
            onclick="window.tkPickDevice('${d.id}')">
            <div style="font-size:13px">${esc(d.hostname || '?')}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${esc(d.user_name || '')}${d.model ? ' · ' + esc(d.model) : ''}</div>
          </div>`).join('')
      : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
  }
  renderDevList()
  input.addEventListener('input', renderDevList)

  window.tkPickDevice = async (deviceId) => {
    closeModal()
    try {
      await window.api.updateTicket(id, { device_id: deviceId })
      await refreshTicket(id)
    } catch { showToast(t('error.generic'), 'error') }
  }
}

async function tkClearDevice(id) {
  try {
    await window.api.updateTicket(id, { device_id: null })
    await refreshTicket(id)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkClearRequester(id) {
  try {
    await window.api.updateTicket(id, { user_id: null })
    await refreshTicket(id)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkOpenTagPicker(ticketId) {
  const tk = _tickets.find(x => x.id === ticketId)
  const currentIds = new Set((tk?.tags || []).map(g => g.id))

  showModal(`
    <div class="modal-title">${t('tickets.tags.add')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="tk-tag-q" placeholder="${t('tickets.tags.search')}" autocomplete="off" oninput="window.tkRenderTagPicker()">
      <div id="tk-tag-list" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:4px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)

  window.tkRenderTagPicker = () => {
    const q = (document.getElementById('tk-tag-q')?.value || '').trim().toLowerCase()
    const list = document.getElementById('tk-tag-list')
    if (!list) return
    const matching = _allTags.filter(t => t.name.toLowerCase().includes(q))
    const exact    = _allTags.find(t => t.name.toLowerCase() === q)

    let html = matching.map(g => {
      const already = currentIds.has(g.id)
      const onclick = already ? '' : `onclick="window.tkPickTag('${ticketId}','${g.id}')"`
      return `<div ${onclick} style="padding:6px 10px;cursor:${already?'default':'pointer'};display:flex;align-items:center;gap:8px;opacity:${already?0.5:1}">
        ${tagChip(g)}${already ? `<span style="font-size:11px;color:var(--text-tertiary)">${t('tickets.tags.already_assigned')}</span>` : ''}
      </div>`
    }).join('')

    if (q && !exact) {
      html += `<div style="padding:8px 10px;border-top:0.5px solid var(--border)">
        <button class="btn btn-primary btn-sm" onclick="window.tkCreateAndAssignTag('${ticketId}', ${jsArg(q)})">
          <i class="ti ti-plus"></i> ${t('tickets.tags.create_and_add')} « ${esc(q)} »
        </button>
      </div>`
    }
    if (!html) html = `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.tags.empty')}</div>`
    list.innerHTML = html
  }

  window.tkPickTag = async (tid, tagId) => {
    try {
      await window.api.addTicketTag(tid, tagId)
      closeModal()
      await refreshTicket(tid)
    } catch { showToast(t('error.generic'), 'error') }
  }

  window.tkCreateAndAssignTag = async (tid, name) => {
    try {
      const newTag = await window.api.createTag({ name, color: 'slate' })
      _allTags.push(newTag)
      await window.api.addTicketTag(tid, newTag.id)
      closeModal()
      await refreshTicket(tid)
    } catch (err) {
      showToast(err.message || t('error.generic'), 'error')
    }
  }

  setTimeout(() => document.getElementById('tk-tag-q')?.focus(), 50)
  window.tkRenderTagPicker()
}

async function tkRemoveTagFromTicket(ticketId, tagId) {
  try {
    await window.api.removeTicketTag(ticketId, tagId)
    await refreshTicket(ticketId)
  } catch { showToast(t('error.generic'), 'error') }
}

async function refreshTicket(id) {
  const tk = await window.api.getTicket(id)
  // mettre à jour la liste en mémoire
  const idx = _tickets.findIndex(t => t.id === id)
  if (idx !== -1) _tickets[idx] = { ..._tickets[idx], ...tk, messages: undefined }
  renderListOrKanban()
  if (_activeId === id) renderDetail(tk)
}

// ─── Filtres : statut, recherche locale ──────────────────────────────────────

function filterTickets(q) { _localQ = q; renderListOrKanban() }

async function setStatusFilter(s) {
  _filters.status = s
  document.querySelectorAll('[id^="tf-"]').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.id === `tf-${s}`)
  })
  writeFiltersToHash()
  await loadTickets()
  renderActiveChips()
}

// ─── Filtres avancés ─────────────────────────────────────────────────────────

function hasActiveAdvanced() {
  return _filters.priority.length > 0
      || _filters.tag.length > 0
      || !!_filters.assigned_to
      || !!_filters.created_from
      || !!_filters.created_to
}

function toggleAdvanced() {
  _showAdvanced = !_showAdvanced
  const panel = document.getElementById('tk-adv-panel')
  if (panel) panel.style.display = _showAdvanced ? 'block' : 'none'
  if (_showAdvanced) renderAdvancedPanel()
}

function renderAdvancedPanel() {
  const panel = document.getElementById('tk-adv-panel')
  if (!panel) return
  const prios = ['low', 'normal', 'high', 'critical']

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('tickets.filters.priority')}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${prios.map(p => `
            <button class="btn btn-sm ${_filters.priority.includes(p)?'btn-primary':''}" onclick="tkSetPriorityFilter('${p}')">
              ${prioLabel(p)}
            </button>
          `).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('tickets.filters.tags')}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${_allTags.length
            ? _allTags.map(g => `
              <span style="cursor:pointer;opacity:${_filters.tag.includes(g.id)?1:0.55}" onclick="tkToggleTagFilter('${g.id}')">
                ${tagChip(g)}
              </span>
            `).join('')
            : `<span style="font-size:11px;color:var(--text-tertiary)">${t('tickets.tags.empty')}</span>`}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('tickets.filters.assignee')}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-sm ${_filters.assigned_to==='me'?'btn-primary':''}" onclick="tkSetAssignedFilter('me','${esc(t('tickets.filters.assignee_me'))}')">${t('tickets.filters.assignee_me')}</button>
          <button class="btn btn-sm ${_filters.assigned_to==='unassigned'?'btn-primary':''}" onclick="tkSetAssignedFilter('unassigned','${esc(t('tickets.filters.assignee_unassigned'))}')">${t('tickets.filters.assignee_unassigned')}</button>
          <button class="btn btn-sm" onclick="tkOpenAssignedPicker()">
            ${_filters.assigned_to && _filters.assigned_to!=='me' && _filters.assigned_to!=='unassigned'
              ? `${t('tickets.filters.assignee_user')}: ${esc(_filters.assigned_label || _filters.assigned_to)}`
              : `<i class="ti ti-search" style="font-size:11px"></i> ${t('tickets.filters.assignee_pick')}`}
          </button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div style="flex:1;min-width:140px">
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('tickets.filters.from')}</div>
          <input type="date" class="form-input" value="${esc(_filters.created_from)}" onchange="tkSetDateFilter('from', this.value)">
        </div>
        <div style="flex:1;min-width:140px">
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${t('tickets.filters.to')}</div>
          <input type="date" class="form-input" value="${esc(_filters.created_to)}" onchange="tkSetDateFilter('to', this.value)">
        </div>
      </div>
      <div>
        <button class="btn btn-sm" onclick="tkClearFilters()"><i class="ti ti-x"></i> ${t('tickets.filters.clear')}</button>
      </div>
    </div>`
}

async function tkSetPriorityFilter(p) {
  const i = _filters.priority.indexOf(p)
  if (i === -1) _filters.priority.push(p)
  else _filters.priority.splice(i, 1)
  writeFiltersToHash()
  await loadTickets()
  renderAdvancedPanel()
  renderActiveChips()
}

async function tkToggleTagFilter(tagId) {
  const i = _filters.tag.indexOf(tagId)
  if (i === -1) _filters.tag.push(tagId)
  else _filters.tag.splice(i, 1)
  writeFiltersToHash()
  await loadTickets()
  renderAdvancedPanel()
  renderActiveChips()
}

async function tkSetAssignedFilter(value, label) {
  if (_filters.assigned_to === value) {
    _filters.assigned_to = ''
    _filters.assigned_label = ''
  } else {
    _filters.assigned_to = value
    _filters.assigned_label = label || ''
  }
  writeFiltersToHash()
  await loadTickets()
  renderAdvancedPanel()
  renderActiveChips()
}

function tkOpenAssignedPicker() {
  showModal(`
    <div class="modal-title">${t('tickets.filters.assignee_pick')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="form-input" id="tk-fa-q" placeholder="${t('tickets.assignee.search')}" autocomplete="off">
      <div id="tk-fa-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
  const input = document.getElementById('tk-fa-q')
  const list  = document.getElementById('tk-fa-results')
  setTimeout(() => input?.focus(), 50)

  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      try {
        const users = await window.api.searchUsers(q)
        list.innerHTML = users.length
          ? users.map(u => `
              <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                onclick="window.tkPickAssignedFilter('${u.entra_id}', ${jsArg(u.display_name)})">
                <div style="font-size:13px">${esc(u.display_name)}</div>
                ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
              </div>`).join('')
          : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
      } catch { list.innerHTML = '' }
    }, 200)
  })

  window.tkPickAssignedFilter = async (entraId, name) => {
    closeModal()
    _filters.assigned_to = entraId
    _filters.assigned_label = name
    writeFiltersToHash()
    await loadTickets()
    renderAdvancedPanel()
    renderActiveChips()
  }
}

async function tkSetDateFilter(which, value) {
  if (which === 'from') _filters.created_from = value
  else                  _filters.created_to   = value
  writeFiltersToHash()
  await loadTickets()
  renderActiveChips()
}

async function tkClearFilters() {
  _filters = defaultFilters()
  writeFiltersToHash()
  document.querySelectorAll('[id^="tf-"]').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.id === 'tf-all')
  })
  await loadTickets()
  renderAdvancedPanel()
  renderActiveChips()
}

function renderActiveChips() {
  const el = document.getElementById('tk-active-chips')
  if (!el) return
  const chips = []
  for (const p of _filters.priority) {
    chips.push(chipHtml(`${t('tickets.filters.priority')}: ${prioLabel(p)}`, `priority:${p}`))
  }
  for (const tagId of _filters.tag) {
    const g = _allTags.find(x => x.id === tagId)
    chips.push(chipHtml(`${t('tickets.filters.tags')}: ${g?.name || tagId}`, `tag:${tagId}`))
  }
  if (_filters.assigned_to) {
    let label = _filters.assigned_label || _filters.assigned_to
    if (_filters.assigned_to === 'me')         label = t('tickets.filters.assignee_me')
    if (_filters.assigned_to === 'unassigned') label = t('tickets.filters.assignee_unassigned')
    chips.push(chipHtml(`${t('tickets.filters.assignee')}: ${label}`, 'assigned_to'))
  }
  if (_filters.created_from) chips.push(chipHtml(`${t('tickets.filters.from')}: ${_filters.created_from}`, 'created_from'))
  if (_filters.created_to)   chips.push(chipHtml(`${t('tickets.filters.to')}: ${_filters.created_to}`, 'created_to'))

  if (chips.length) {
    el.style.display = 'flex'
    el.innerHTML = chips.join('') + `<button class="btn btn-sm" style="font-size:11px;padding:1px 8px" onclick="tkClearFilters()"><i class="ti ti-x"></i> ${t('tickets.filters.clear_all')}</button>`
  } else {
    el.style.display = 'none'
    el.innerHTML = ''
  }
}

function chipHtml(label, key) {
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-tertiary);color:var(--text-primary);padding:2px 8px;border-radius:10px;font-size:11px">
    ${esc(label)}
    <span style="cursor:pointer;opacity:0.7" onclick="tkRemoveChip('${key}')">×</span>
  </span>`
}

async function tkRemoveChip(key) {
  if (key.startsWith('priority:')) {
    const p = key.split(':')[1]
    _filters.priority = _filters.priority.filter(x => x !== p)
  } else if (key.startsWith('tag:')) {
    const id = key.split(':')[1]
    _filters.tag = _filters.tag.filter(x => x !== id)
  } else if (key === 'assigned_to') {
    _filters.assigned_to = ''
    _filters.assigned_label = ''
  } else if (key === 'created_from') {
    _filters.created_from = ''
  } else if (key === 'created_to') {
    _filters.created_to = ''
  }
  writeFiltersToHash()
  await loadTickets()
  renderAdvancedPanel()
  renderActiveChips()
}

// ─── Modal "Gérer les tags" ──────────────────────────────────────────────────

// ─── Modal "Propositions" (tickets proposés à valider) ──────────────────────

async function openProposalsModal() {
  let list = []
  try { list = await window.api.getProposals({ status: 'pending' }) } catch { list = [] }

  showModal(`
    <div class="modal-title">${t('tickets.proposals.title')} (${list.length})</div>
    <div style="max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-top:10px">
      ${list.length
        ? list.map(p => proposalCard(p)).join('')
        : `<div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:13px">${t('tickets.proposals.empty')}</div>`}
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
}

function proposalCard(p) {
  const sourceMap = {
    alert:  t('tickets.proposals.source.alert'),
    script: t('tickets.proposals.source.script'),
    email:  t('tickets.proposals.source.email'),
    manual: t('tickets.proposals.source.manual'),
  }
  const sourceLabel = sourceMap[p.source] || p.source
  const prioColor = p.suggested_priority === 'critical' ? '#dc2626'
                  : p.suggested_priority === 'high'     ? '#d97706'
                  : p.suggested_priority === 'low'      ? '#64748b'
                  : '#0d9488'
  return `
    <div style="border:0.5px solid var(--border);border-radius:6px;padding:10px;background:var(--bg-secondary)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:13px">${esc(p.suggested_title)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap">
            <span style="background:var(--bg-tertiary);padding:1px 6px;border-radius:8px"><i class="ti ti-bulb" style="font-size:10px"></i> ${esc(sourceLabel)}</span>
            <span style="color:${prioColor}">● ${prioLabel(p.suggested_priority)}</span>
            <span>${formatRelative(p.created_at)}</span>
          </div>
          ${p.suggested_description ? `<div style="margin-top:6px;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;max-height:80px;overflow:auto">${esc(p.suggested_description)}</div>` : ''}
          ${(p.device_hostname || p.user_display_name) ? `
            <div style="margin-top:6px;font-size:11px;color:var(--text-tertiary);display:flex;gap:8px;flex-wrap:wrap">
              ${p.device_hostname    ? `<span><i class="ti ti-device-laptop" style="font-size:10px"></i> ${esc(p.device_hostname)}</span>`    : ''}
              ${p.user_display_name  ? `<span><i class="ti ti-user" style="font-size:10px"></i> ${esc(p.user_display_name)}</span>`           : ''}
            </div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
        <button class="btn btn-sm" onclick="window.tkRejectProposal('${p.id}')">${t('tickets.proposals.reject')}</button>
        <button class="btn btn-primary btn-sm" onclick="window.tkAcceptProposal('${p.id}')">${t('tickets.proposals.accept')}</button>
      </div>
    </div>`
}

async function tkAcceptProposal(id) {
  try {
    const result = await window.api.acceptProposal(id, {})
    showToast(t('tickets.proposals.toast.accepted'), 'success')
    await loadProposalsCount()
    await loadTickets()
    if (_proposalsCount > 0) openProposalsModal()
    else                     closeModal()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function tkRejectProposal(id) {
  const reason = prompt(t('tickets.proposals.reject_reason_prompt'))
  if (reason === null) return  // annulation
  try {
    await window.api.rejectProposal(id, reason || null)
    showToast(t('tickets.proposals.toast.rejected'), 'info')
    await loadProposalsCount()
    if (_proposalsCount > 0) openProposalsModal()
    else                     closeModal()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

async function openTagsModal() {
  await loadTags()
  showModal(tagsModalContent())

  window.tkCreateTag = async () => {
    const name  = document.getElementById('tg-name')?.value?.trim()
    const color = document.getElementById('tg-color')?.value || 'slate'
    if (!name) { showToast(t('tickets.tags.name_required'), 'error'); return }
    try {
      const tag = await window.api.createTag({ name, color })
      _allTags.push(tag)
      _allTags.sort((a, b) => a.name.localeCompare(b.name))
      // re-render dans la modal (réinjection du contenu)
      const root = document.getElementById('modal-content')
      if (root) root.innerHTML = tagsModalContent()
      renderAdvancedPanel()
      renderActiveChips()
      showToast(t('tickets.tags.toast.created'), 'success')
    } catch (err) { showToast(err.message || t('error.generic'), 'error') }
  }

  window.tkDeleteTag = async (id, name) => {
    if (!confirm(t('tickets.tags.confirm_delete').replace('{name}', name))) return
    try {
      await window.api.deleteTag(id)
      _allTags = _allTags.filter(t => t.id !== id)
      _filters.tag = _filters.tag.filter(t => t !== id)
      const root = document.getElementById('modal-content')
      if (root) root.innerHTML = tagsModalContent()
      writeFiltersToHash()
      await loadTickets()
      renderAdvancedPanel()
      renderActiveChips()
      showToast(t('tickets.tags.toast.deleted'), 'success')
    } catch { showToast(t('error.generic'), 'error') }
  }
}

function tagsModalContent() {
  return `
    <div class="modal-title">${t('tickets.tags.manage')}</div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="font-size:12px;color:var(--text-secondary)">${t('tickets.tags.create_new')}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input class="form-input" id="tg-name" placeholder="${t('tickets.tags.name_placeholder')}" style="flex:1;min-width:160px" autocomplete="off">
          <select class="form-select" id="tg-color" style="width:auto">
            ${TAG_COLOR_KEYS.map(k => `<option value="${k}">${TAG_PALETTE[k].label}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="window.tkCreateTag()">${t('btn.create')}</button>
        </div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">${t('tickets.tags.existing')} (${_allTags.length})</div>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto">
          ${_allTags.length
            ? _allTags.map(g => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--bg-secondary)">
                ${tagChip(g)}
                <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="window.tkDeleteTag('${g.id}', ${jsArg(g.name)})">
                  <i class="ti ti-trash"></i>
                </button>
              </div>`).join('')
            : `<div style="font-size:12px;color:var(--text-tertiary);padding:8px">${t('tickets.tags.empty')}</div>`}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`
}

// ─── Modal nouveau ticket ────────────────────────────────────────────────────
// Pickers tags / assigné en mode inline (zones expansibles dans la même modal),
// pour ne pas perdre le titre/description saisis lors d'une ouverture imbriquée.

function openNewTicketModal({ prefillDevice = null } = {}) {
  let selectedTags    = []
  let pickedAssignee  = null  // { entra_id, display_name }
  let pickedRequester = null  // { entra_id, display_name, email }
  let pickedDevice    = prefillDevice  // { id, hostname } — pré-rempli si depuis fiche poste
  let allDevicesCache = null  // chargé à la demande

  showModal(`
    <div class="modal-title">${t('tickets.new.title')}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <label class="form-label">${t('tickets.new.label_title')}</label>
        <input class="form-input" id="nt-title" placeholder="${t('tickets.new.placeholder_title')}" autocomplete="off">
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">${t('tickets.new.priority')}</label>
          <select class="form-select" id="nt-priority">
            <option value="low">${t('prio.low')}</option>
            <option value="normal" selected>${t('prio.normal')}</option>
            <option value="high">${t('prio.high')}</option>
            <option value="critical">${t('prio.critical')}</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${t('tickets.info.assignee')}</label>
        <div id="nt-assignee-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>
        <div id="nt-assignee-search" style="display:none;margin-top:6px">
          <input class="form-input" id="nt-aq" placeholder="${t('tickets.assignee.search')}" autocomplete="off">
          <div id="nt-ar" style="max-height:200px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px"></div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${t('tickets.info.requester')}</label>
        <div id="nt-requester-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>
        <div id="nt-requester-search" style="display:none;margin-top:6px">
          <input class="form-input" id="nt-rq" placeholder="${t('tickets.requester.search')}" autocomplete="off">
          <div id="nt-rr" style="max-height:200px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px"></div>
        </div>
      </div>
      ${window.OPALE.moduleEnabled('inventory') ? `
      <div class="form-row">
        <label class="form-label">${t('tickets.info.device')}</label>
        <div id="nt-device-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>
        <div id="nt-device-search" style="display:none;margin-top:6px">
          <input class="form-input" id="nt-dq" placeholder="${t('tickets.device.search')}" autocomplete="off">
          <div id="nt-dr" style="max-height:200px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px"></div>
        </div>
      </div>` : ''}
      <div class="form-row">
        <label class="form-label">${t('tickets.info.tags')}</label>
        <div id="nt-tags-area" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center"></div>
        <div id="nt-tags-search" style="display:none;margin-top:6px">
          <input class="form-input" id="nt-tq" placeholder="${t('tickets.tags.search')}" autocomplete="off" oninput="window.ntRenderTagSearch()">
          <div id="nt-tl" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-top:4px"></div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">${t('tickets.new.description')}</label>
        <textarea class="form-textarea" id="nt-desc" placeholder="${t('tickets.new.placeholder_desc')}"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="submitNewTicket()">${t('btn.create')}</button>
    </div>`)

  // ── Assignee (inline) ──
  function renderAssigneeRow() {
    const row = document.getElementById('nt-assignee-row')
    if (!row) return
    if (pickedAssignee) {
      row.innerHTML = `
        <span style="font-size:13px">${esc(pickedAssignee.display_name)}</span>
        <button class="btn btn-sm" type="button" onclick="window.ntToggleAssigneeSearch()"><i class="ti ti-pencil" style="font-size:11px"></i></button>
        <button class="btn btn-sm" type="button" onclick="window.ntUnassign()">${t('tickets.unassign')}</button>`
    } else {
      row.innerHTML = `
        <span style="font-size:13px;color:var(--text-tertiary)">${t('tickets.unassigned')}</span>
        <button class="btn btn-sm" type="button" onclick="window.ntAssignSelf()">${t('tickets.assign_self')}</button>
        <button class="btn btn-sm" type="button" onclick="window.ntToggleAssigneeSearch()"><i class="ti ti-search" style="font-size:11px"></i></button>`
    }
  }
  window.ntAssignSelf = () => {
    const me = window.appState?.user
    if (!me?.entraId) return
    pickedAssignee = { entra_id: me.entraId, display_name: me.displayName }
    document.getElementById('nt-assignee-search').style.display = 'none'
    renderAssigneeRow()
  }
  window.ntUnassign = () => {
    pickedAssignee = null
    renderAssigneeRow()
  }
  window.ntToggleAssigneeSearch = () => {
    const box = document.getElementById('nt-assignee-search')
    if (!box) return
    const isOpen = box.style.display === 'block'
    box.style.display = isOpen ? 'none' : 'block'
    if (!isOpen) setTimeout(() => document.getElementById('nt-aq')?.focus(), 50)
  }

  let assigneeTimer
  document.getElementById('nt-aq')?.addEventListener('input', (e) => {
    clearTimeout(assigneeTimer)
    const q = e.target.value.trim()
    const lst = document.getElementById('nt-ar')
    if (q.length < 2) { lst.innerHTML = ''; return }
    assigneeTimer = setTimeout(async () => {
      const users = await window.api.searchUsers(q).catch(() => [])
      lst.innerHTML = users.length
        ? users.map(u => `
            <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
              onclick="window.ntApplyAssignee('${u.entra_id}', ${jsArg(u.display_name)})">
              <div style="font-size:13px">${esc(u.display_name)}</div>
              ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
            </div>`).join('')
        : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
    }, 200)
  })
  window.ntApplyAssignee = (entraId, name) => {
    pickedAssignee = { entra_id: entraId, display_name: name }
    document.getElementById('nt-assignee-search').style.display = 'none'
    document.getElementById('nt-aq').value = ''
    document.getElementById('nt-ar').innerHTML = ''
    renderAssigneeRow()
  }

  // ── Requester (inline) ──
  function renderRequesterRow() {
    const row = document.getElementById('nt-requester-row')
    if (!row) return
    if (pickedRequester) {
      row.innerHTML = `
        <span style="font-size:13px">${esc(pickedRequester.display_name)}</span>
        ${pickedRequester.email ? `<span style="font-size:11px;color:var(--text-tertiary)">${esc(pickedRequester.email)}</span>` : ''}
        <button class="btn btn-sm" type="button" onclick="window.ntToggleRequesterSearch()"><i class="ti ti-pencil" style="font-size:11px"></i></button>
        <button class="btn btn-sm" type="button" onclick="window.ntClearRequester()">${t('tickets.clear_requester')}</button>`
    } else {
      row.innerHTML = `
        <span style="font-size:13px;color:var(--text-tertiary)">${t('tickets.no_requester')}</span>
        <button class="btn btn-sm" type="button" onclick="window.ntToggleRequesterSearch()"><i class="ti ti-search" style="font-size:11px"></i> ${t('tickets.requester.pick')}</button>`
    }
  }
  window.ntClearRequester = () => {
    pickedRequester = null
    renderRequesterRow()
  }
  window.ntToggleRequesterSearch = () => {
    const box = document.getElementById('nt-requester-search')
    if (!box) return
    const isOpen = box.style.display === 'block'
    box.style.display = isOpen ? 'none' : 'block'
    if (!isOpen) setTimeout(() => document.getElementById('nt-rq')?.focus(), 50)
  }
  let requesterTimer
  document.getElementById('nt-rq')?.addEventListener('input', (e) => {
    clearTimeout(requesterTimer)
    const q = e.target.value.trim()
    const lst = document.getElementById('nt-rr')
    if (q.length < 2) { lst.innerHTML = ''; return }
    requesterTimer = setTimeout(async () => {
      const users = await window.api.searchUsers(q).catch(() => [])
      lst.innerHTML = users.length
        ? users.map(u => `
            <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
              onclick="window.ntApplyRequester('${u.entra_id}', ${jsArg(u.display_name)}, ${jsArg(u.email || '')})">
              <div style="font-size:13px">${esc(u.display_name)}</div>
              ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
            </div>`).join('')
        : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
    }, 200)
  })
  window.ntApplyRequester = (entraId, name, email) => {
    pickedRequester = { entra_id: entraId, display_name: name, email: email || '' }
    document.getElementById('nt-requester-search').style.display = 'none'
    document.getElementById('nt-rq').value = ''
    document.getElementById('nt-rr').innerHTML = ''
    renderRequesterRow()
  }

  // ── Device (inline) avec auto-suggestion via requester ──
  function renderDeviceRow() {
    const row = document.getElementById('nt-device-row')
    if (!row) return
    if (pickedDevice) {
      row.innerHTML = `
        <span style="font-size:13px"><i class="ti ti-device-laptop" style="font-size:11px;opacity:0.7"></i> ${esc(pickedDevice.hostname)}</span>
        <button class="btn btn-sm" type="button" onclick="window.ntToggleDeviceSearch()"><i class="ti ti-pencil" style="font-size:11px"></i></button>
        <button class="btn btn-sm" type="button" onclick="window.ntClearDevice()">${t('tickets.clear_device')}</button>`
    } else {
      row.innerHTML = `
        <span style="font-size:13px;color:var(--text-tertiary)">${t('tickets.no_device')}</span>
        <button class="btn btn-sm" type="button" onclick="window.ntToggleDeviceSearch()"><i class="ti ti-search" style="font-size:11px"></i> ${t('tickets.device.pick')}</button>`
    }
  }
  window.ntClearDevice = () => { pickedDevice = null; renderDeviceRow() }
  window.ntToggleDeviceSearch = async () => {
    const box = document.getElementById('nt-device-search')
    if (!box) return
    const isOpen = box.style.display === 'block'
    box.style.display = isOpen ? 'none' : 'block'
    if (!isOpen) {
      if (!allDevicesCache) {
        try { allDevicesCache = (await window.api.getDevices({ limit: 200 }))?.devices || [] } catch { allDevicesCache = [] }
      }
      ntRenderDeviceList()
      setTimeout(() => document.getElementById('nt-dq')?.focus(), 50)
    }
  }
  window.ntRenderDeviceList = () => {
    const q = (document.getElementById('nt-dq')?.value || '').trim().toLowerCase()
    const lst = document.getElementById('nt-dr')
    if (!lst) return
    const list = allDevicesCache || []
    const filtered = q
      ? list.filter(d => (d.hostname || '').toLowerCase().includes(q) ||
                         (d.user_name || '').toLowerCase().includes(q) ||
                         (d.model || '').toLowerCase().includes(q))
      : list.slice(0, 50)
    lst.innerHTML = filtered.length
      ? filtered.map(d => `
          <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
            onclick="window.ntApplyDevice('${d.id}', ${jsArg(d.hostname || '?')})">
            <div style="font-size:13px">${esc(d.hostname || '?')}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${esc(d.user_name || '')}${d.model ? ' · ' + esc(d.model) : ''}</div>
          </div>`).join('')
      : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.assignee.no_match')}</div>`
  }
  window.ntApplyDevice = (deviceId, hostname) => {
    pickedDevice = { id: deviceId, hostname }
    document.getElementById('nt-device-search').style.display = 'none'
    document.getElementById('nt-dq').value = ''
    document.getElementById('nt-dr').innerHTML = ''
    renderDeviceRow()
  }
  document.getElementById('nt-dq')?.addEventListener('input', () => window.ntRenderDeviceList())

  // Auto-suggestion : quand un requester est appliqué, fetch son device et le pré-remplir
  // (on enveloppe ntApplyRequester pour ajouter ce comportement)
  const _origApplyRequester = window.ntApplyRequester
  window.ntApplyRequester = async (entraId, name, email) => {
    _origApplyRequester(entraId, name, email)
    if (pickedDevice) return  // ne pas écraser un poste déjà choisi explicitement
    try {
      const u = await window.api.getUser(entraId)
      if (u?.device?.id && u.device.hostname) {
        pickedDevice = { id: u.device.id, hostname: u.device.hostname }
        renderDeviceRow()
        showToast(t('tickets.device.suggested'), 'info')
      }
    } catch { /* silencieux */ }
  }

  // ── Tags (inline) ──
  function renderTagsArea() {
    const area = document.getElementById('nt-tags-area')
    if (!area) return
    const chips = selectedTags.map(g => tagChip(g, { onRemove: `window.ntRemoveTag('${g.id}')` })).join('')
    area.innerHTML = chips + `
      <button class="btn btn-sm" type="button" onclick="window.ntToggleTagSearch()" style="padding:2px 8px;font-size:11px">
        <i class="ti ti-plus"></i> ${t('tickets.add_tag')}
      </button>`
  }
  window.ntToggleTagSearch = () => {
    const box = document.getElementById('nt-tags-search')
    if (!box) return
    const isOpen = box.style.display === 'block'
    box.style.display = isOpen ? 'none' : 'block'
    if (!isOpen) {
      window.ntRenderTagSearch()
      setTimeout(() => document.getElementById('nt-tq')?.focus(), 50)
    }
  }
  window.ntRenderTagSearch = () => {
    const q = (document.getElementById('nt-tq')?.value || '').trim().toLowerCase()
    const list = document.getElementById('nt-tl')
    if (!list) return
    const matching = _allTags.filter(t => t.name.toLowerCase().includes(q))
    const exact    = _allTags.find(t => t.name.toLowerCase() === q)
    const taken    = new Set(selectedTags.map(t => t.id))
    let html = matching.map(g => {
      if (taken.has(g.id)) return `<div style="padding:6px 10px;opacity:0.5">${tagChip(g)}</div>`
      return `<div style="padding:6px 10px;cursor:pointer" onclick="window.ntApplyTag('${g.id}')">${tagChip(g)}</div>`
    }).join('')
    if (q && !exact) {
      html += `<div style="padding:8px 10px;border-top:0.5px solid var(--border)">
        <button class="btn btn-primary btn-sm" type="button" onclick="window.ntCreateTag(${jsArg(q)})">
          <i class="ti ti-plus"></i> ${t('tickets.tags.create_and_add')} « ${esc(q)} »
        </button></div>`
    }
    if (!html) html = `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.tags.empty')}</div>`
    list.innerHTML = html
  }
  window.ntApplyTag = (tagId) => {
    const g = _allTags.find(x => x.id === tagId)
    if (g && !selectedTags.some(x => x.id === g.id)) selectedTags.push(g)
    document.getElementById('nt-tq').value = ''
    renderTagsArea()
    window.ntRenderTagSearch()
  }
  window.ntCreateTag = async (name) => {
    try {
      const newTag = await window.api.createTag({ name, color: 'slate' })
      _allTags.push(newTag)
      _allTags.sort((a, b) => a.name.localeCompare(b.name))
      selectedTags.push(newTag)
      document.getElementById('nt-tq').value = ''
      renderTagsArea()
      window.ntRenderTagSearch()
    } catch (err) { showToast(err.message || t('error.generic'), 'error') }
  }
  window.ntRemoveTag = (tagId) => {
    selectedTags = selectedTags.filter(g => g.id !== tagId)
    renderTagsArea()
  }

  window.submitNewTicket = async () => {
    const title    = document.getElementById('nt-title')?.value?.trim()
    const priority = document.getElementById('nt-priority')?.value
    const desc     = document.getElementById('nt-desc')?.value?.trim()
    if (!title) { showToast(t('tickets.new.title_required'), 'error'); return }
    try {
      const tk = await window.api.createTicket({
        title, priority, description: desc,
        assigned_to_entra_id: pickedAssignee?.entra_id || null,
        assigned_to_name:     pickedAssignee?.display_name || null,
        user_id:              pickedRequester?.entra_id || null,
        device_id:            pickedDevice?.id || null,
        tag_ids: selectedTags.map(g => g.id),
      })
      closeModal()
      _tickets.unshift(tk)
      renderListOrKanban()
      showToast(t('tickets.toast.created'), 'success')
      if (_view === 'kanban') tkOpenDrawer(tk.id)
      else                    selectTicket(tk.id)
    } catch {
      showToast(t('error.generic'), 'error')
    }
  }

  renderAssigneeRow()
  renderRequesterRow()
  renderDeviceRow()
  renderTagsArea()
}

// ─── helpers ────────────────────────────────────────────────────────────────

function statusLabel(s) {
  return s === 'open'        ? t('tickets.status.open')
       : s === 'in_progress' ? t('tickets.status.in_progress')
       : s === 'resolved'    ? t('tickets.status.resolved')
       : s
}
function prioLabel(p) {
  return p === 'low'      ? t('prio.low')
       : p === 'normal'   ? t('prio.normal')
       : p === 'high'     ? t('prio.high')
       : p === 'critical' ? t('prio.critical')
       : p
}
