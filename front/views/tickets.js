// Vue Tickets — trois modes : liste (split liste / détail), Kanban, et
// « À trier » (mails entrants à transformer en tickets).
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

function initialsOf(name) {
  return (name || '?').split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

// Référence courte d'un ticket : 8 premiers hex de l'UUID, en majuscules —
// c'est le tag [Opale #XXXXXXXX] posé dans le sujet des mails sortants
// (cf. api email-bridge/lib/thread-headers.js). Recherchable dans Outlook.
function ticketRef(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase()
}

// Liens cliquables vers les fiches device / user (clic milieu + ctrl+clic ok).
function deviceLink(deviceId, hostname) {
  if (!hostname) return ''
  if (!deviceId) return esc(hostname)
  return `<a href="#/postes/${esc(deviceId)}" onclick="event.stopPropagation()">${esc(hostname)}</a>`
}

function userLink(entraId, displayName) {
  if (!displayName) return ''
  if (!entraId) return esc(displayName)
  return `<a href="#/users/${esc(entraId)}" onclick="event.stopPropagation()">${esc(displayName)}</a>`
}

// Nettoie au rendu les descriptions HTML des tickets créés avant le fix
// htmlToText (issue #8). Sans balise Outlook caractéristique, texte intact.
function cleanLegacyHtml(text) {
  if (!text) return text
  const s = String(text)
  if (!/<(html|body|head|div|p|br|meta|style)[\s>]/i.test(s)) return s
  return s
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<li\s*>/gi, '- ')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Date absolue courte, localisée : « 12 mars, 14:05 » (année si différente).
function fmtDateShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const loc = (window.getLocale?.() || 'fr') === 'en' ? 'en-GB' : 'fr-FR'
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
    + ', ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
}
function fmtDateFull(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const loc = (window.getLocale?.() || 'fr') === 'en' ? 'en-GB' : 'fr-FR'
  return d.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
}
// Relatif si récent (< 24 h), sinon date courte. Le title porte la date complète.
function whenHtml(iso) {
  if (!iso) return ''
  const age = Date.now() - new Date(iso).getTime()
  const txt = age < 86_400_000 ? formatRelative(iso) : fmtDateShort(iso)
  return `<span title="${esc(fmtDateFull(iso))}">${esc(txt)}</span>`
}
function dayKey(iso) {
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toISOString().slice(0, 10)
}
function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date(); const yest = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return t('tickets.day.today')
  if (d.toDateString() === yest.toDateString())  return t('tickets.day.yesterday')
  const loc = (window.getLocale?.() || 'fr') === 'en' ? 'en-GB' : 'fr-FR'
  return d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'long', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })
}

// Affiche updated_at si différent de created_at (mode hybride), sinon created_at.
function displayWhen(tk) {
  if (!tk.updated_at || tk.updated_at === tk.created_at) return formatRelative(tk.created_at)
  return `${t('tickets.maj_prefix')} ${formatRelative(tk.updated_at)}`
}

// Point rouge : le dernier message n'est pas de moi → réponse attendue.
function awaitingDot(tk) {
  if (!tk.awaiting_reply) return ''
  return `<span class="tk-unread" title="${esc(t('tickets.awaiting_reply'))}"></span>`
}

function statusPill(status) {
  const known = ['open', 'in_progress', 'resolved', 'closed', 'merged'].includes(status)
  return `<span class="st-pill ${known ? 'st-' + status : 'st-closed'}">${statusLabel(status)}</span>`
}
function prioPill(p, { clickable = false, ticketId = null } = {}) {
  const cls = ['critical', 'high', 'normal', 'low'].includes(p) ? `prio-${p}-c` : 'prio-normal-c'
  const onclick = clickable && ticketId ? ` onclick="tkOpenPriorityPicker('${ticketId}')" style="cursor:pointer" title="${esc(t('tickets.priority.change'))}"` : ''
  return `<span class="prio-pill ${cls}"${onclick}><span class="prio-dot"></span>${prioLabel(p)}</span>`
}
function sourceChip(tk) {
  if (tk.source === 'email' || tk.has_inbound_mail) return `<span class="badge badge-green"><i class="ti ti-mail"></i> ${esc(t('tickets.source.email'))}</span>`
  if (tk.is_auto || tk.source === 'auto' || tk.source === 'alert' || tk.source === 'script') return `<span class="badge badge-purple"><i class="ti ti-robot"></i> ${esc(t('tickets.source.auto'))}</span>`
  return ''
}

let _tickets        = []
let _activeId       = null
let _allTags        = []          // référentiel complet
let _filters        = defaultFilters()
let _showAdvanced   = false
let _localQ         = ''          // recherche locale (titre/hostname)
let _view           = 'list'      // 'list' | 'kanban' | 'inbox'
let _proposalsCount = 0
let _inboxCount     = 0
let _composerMode   = 'note'      // 'note' | 'mail' — mémorisé entre deux tickets
let _currentTk      = null        // ticket affiché dans le détail

const KANBAN_COL_CAP = 30
const KANBAN_COLS    = ['open', 'in_progress', 'resolved']
const VIEW_LS_KEY    = 'opale.tickets.view'
const VIEWS          = ['list', 'kanban', 'inbox']

// ─── View persistence : hash > localStorage > 'list' ────────────────────────

function readView() {
  const hash = window.location.hash || ''
  const qIdx = hash.indexOf('?')
  if (qIdx !== -1) {
    const v = new URLSearchParams(hash.slice(qIdx + 1)).get('view')
    if (VIEWS.includes(v)) return v
  }
  try {
    const v = localStorage.getItem(VIEW_LS_KEY)
    if (VIEWS.includes(v)) return v
  } catch {}
  return 'list'
}

function writeView(v) {
  try { localStorage.setItem(VIEW_LS_KEY, v) } catch {}
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
    status: 'all',          // all | open | in_progress | auto | resolved | closed
    priority: [],
    tag: [],
    assigned_to: '',        // entra_id | 'me' | 'unassigned' | ''
    assigned_label: '',
    created_from: '',
    created_to: '',
  }
}

// ─── Hash sync ───────────────────────────────────────────────────────────────

// Le hash est contrôlable par un tiers (lien piégé envoyé à un admin) : on ne
// garde que des valeurs connues avant qu'elles n'atteignent le rendu.
const HASH_STATUSES   = ['all', 'open', 'in_progress', 'auto', 'resolved', 'closed']
const HASH_PRIORITIES = ['low', 'normal', 'high', 'critical']
const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/

function isValidDay(s) {
  if (!DATE_RE.test(s || '')) return false
  const d = new Date(s + 'T00:00:00Z')
  return !isNaN(d) && d.toISOString().slice(0, 10) === s
}

function readFiltersFromHash() {
  const hash = window.location.hash || ''
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return defaultFilters()
  const sp = new URLSearchParams(hash.slice(qIdx + 1))
  const f = defaultFilters()
  if (HASH_STATUSES.includes(sp.get('status'))) f.status = sp.get('status')
  if (sp.get('priority'))     f.priority = sp.get('priority').split(',').filter(p => HASH_PRIORITIES.includes(p))
  if (sp.get('tag'))          f.tag      = sp.get('tag').split(',').filter(id => UUID_RE.test(id))
  if (sp.get('assigned_to'))  f.assigned_to = sp.get('assigned_to')
  if (sp.get('assigned_label'))  f.assigned_label = sp.get('assigned_label')
  if (isValidDay(sp.get('created_from'))) f.created_from = sp.get('created_from')
  if (isValidDay(sp.get('created_to')))   f.created_to   = sp.get('created_to')
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
  if (_view !== 'list')            sp.set('view', _view)

  const hash    = window.location.hash || '#/tickets'
  const pathPart = hash.split('?')[0]
  const qs       = sp.toString()
  const newHash  = qs ? `${pathPart}?${qs}` : pathPart
  if (newHash !== hash) history.replaceState(null, '', newHash)
}

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
  if (_localQ?.trim())             p.q = _localQ.trim()
  return p
}

// ─── Render principal ────────────────────────────────────────────────────────

export async function renderTickets(container, opts = {}) {
  // Deep-link `?new=true&device=<id>` capturé AVANT tout render (un
  // replaceState de selectTicket effacerait le `?…`).
  let pendingNewModal = null
  const initialQs = (window.location.hash || '').split('?')[1]
  if (initialQs) {
    const params = new URLSearchParams(initialQs)
    if (params.get('new') === 'true') {
      pendingNewModal = { deviceId: params.get('device') }
      _activeId = null
    }
  }

  // Deep-link : `#/tickets/<id>` ouvre directement ce ticket (partageable).
  if (opts.ticketId) _activeId = opts.ticketId

  _filters      = readFiltersFromHash()
  _showAdvanced = hasActiveAdvanced()
  _view         = readView()
  // Un deep-link vers un ticket depuis le mode « À trier » n'a pas de sens :
  // on retombe en liste pour l'afficher.
  if (opts.ticketId && _view === 'inbox') _view = 'list'

  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <span class="page-title">${t('tickets.title')}</span>
        <span class="topbar-sub" id="tk-subtitle"></span>
      </div>
      <div class="topbar-actions">
        <div class="seg" id="tk-seg">
          <button class="seg-btn ${_view==='list'?'active':''}"   onclick="tkSetView('list')"   title="${t('tickets.view.list')}"><i class="ti ti-list"></i> ${t('tickets.view.list_short')}</button>
          <button class="seg-btn ${_view==='kanban'?'active':''}" onclick="tkSetView('kanban')" title="${t('tickets.view.kanban')}"><i class="ti ti-layout-kanban"></i> ${t('tickets.view.kanban_short')}</button>
          <button class="seg-btn ${_view==='inbox'?'active':''}"  onclick="tkSetView('inbox')"  title="${t('tickets.inbox.title')}"><i class="ti ti-mail-opened"></i> ${t('tickets.inbox.short')} <span class="seg-count" id="tk-inbox-count" style="display:none"></span></button>
        </div>
        <button class="btn" id="tk-proposals-btn" style="display:none" onclick="openProposalsModal()" title="${t('tickets.proposals.title')}">
          <i class="ti ti-bulb"></i> ${t('tickets.proposals.title')}
          <span class="seg-count hot" id="tk-proposals-count"></span>
        </button>
        <button class="btn" onclick="openTagsModal()" title="${t('tickets.tags.manage')}">
          <i class="ti ti-tags"></i>
        </button>
        <button class="btn btn-primary" onclick="openNewTicketModal()" title="${t('tickets.new.shortcut_hint')}">
          <i class="ti ti-plus"></i> ${t('btn.new_ticket')}
        </button>
      </div>
    </div>
    <!-- Bandeau stats du pont mail. Caché si l'API renvoie 0. Clic → diagnostic. -->
    <div id="tk-mail-stats" onclick="openMailDiagnosticModal()" style="display:none;padding:6px 20px;font-size:12px;color:var(--text-secondary);border-bottom:0.5px solid var(--border);background:var(--bg-secondary);cursor:pointer" title="${esc(t('tickets.mail_stats.hint'))}"></div>
    <div id="tk-main" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`

  ensureKanbanStyles()

  window.filterTickets        = filterTickets
  window.setStatusFilter      = setStatusFilter
  window.toggleAdvanced       = toggleAdvanced
  window.openNewTicketModal   = openNewTicketModal
  window.openTagsModal        = openTagsModal
  window.selectTicket         = selectTicket
  window.sendReply            = sendReply
  window.sendMsgByMail        = sendMsgByMail
  window.tkRetrySend          = tkRetrySend
  window.tkAiSuggest          = tkAiSuggest
  window.tkUseSuggestion      = tkUseSuggestion
  window.tkDeleteSuggestion   = tkDeleteSuggestion
  window.tkRemoveUser         = tkRemoveUser
  window.tkRemoveDevice       = tkRemoveDevice
  window.tkOpenMergeModal     = tkOpenMergeModal
  window.tkUploadAttachment   = tkUploadAttachment
  window.tkDownloadAttachment = tkDownloadAttachment
  window.tkRemoveAttachment   = tkRemoveAttachment
  window.resolveTicket        = resolveTicket
  window.reopenTicket         = reopenTicket
  window.archiveTicket        = archiveTicket
  window.unarchiveTicket      = unarchiveTicket
  window.takeInProgressTicket = takeInProgressTicket
  window.openMailDiagnosticModal = openMailDiagnosticModal
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
  window.tkOpenPriorityPicker = tkOpenPriorityPicker
  window.tkSetPriority        = tkSetPriority
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
  window.tkSetComposerMode    = tkSetComposerMode
  window.tkComposerKey        = tkComposerKey
  window.tkEditTitle          = tkEditTitle
  window.tkSaveTitle          = tkSaveTitle
  window.tkCancelEditTitle    = tkCancelEditTitle
  window.tkEditDescription    = tkEditDescription
  window.tkSaveDescription    = tkSaveDescription
  window.tkToggleMsg          = tkToggleMsg
  window.tkCopyRef            = tkCopyRef
  window.tkOpenStatusMenu     = tkOpenStatusMenu
  window.tkSetStatus          = tkSetStatus
  window.tkCopyLink           = tkCopyLink
  window.inboxSelect          = inboxSelect
  window.inboxToTicket        = inboxToTicket
  window.inboxOpenAttach      = inboxOpenAttach
  window.inboxDismiss         = inboxDismiss
  window.inboxReload          = inboxReload
  window.inboxFilter          = inboxFilter
  window.inboxToggleRaw       = inboxToggleRaw

  await Promise.all([loadTags(), loadTickets(), loadProposalsCount(), loadInboxCount(), loadEmailStats()])
  renderMain()

  if (pendingNewModal) {
    let prefillDevice = null
    if (pendingNewModal.deviceId) {
      try {
        const dev = await window.api.getDevice(pendingNewModal.deviceId)
        if (dev?.id) prefillDevice = { id: dev.id, hostname: dev.hostname }
      } catch {}
    }
    history.replaceState(null, '', '#/tickets')
    openNewTicketModal({ prefillDevice })
  }

  // Raccourcis clavier (hors champ de saisie) : n = nouveau ticket,
  // j / k = ticket suivant / précédent, e = renommer, r = focus réponse.
  if (!window._tkKeysBound) {
    window._tkKeysBound = true
    document.addEventListener('keydown', tkGlobalKeys)
  }
}

function tkGlobalKeys(e) {
  if (!document.getElementById('tk-main')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = (e.target?.tagName || '').toLowerCase()
  if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return
  if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) return
  if (e.key === 'n') { e.preventDefault(); openNewTicketModal() }
  else if ((e.key === 'j' || e.key === 'k') && _view === 'list') {
    const ids = applyLocalSearch(_tickets, _localQ).map(x => x.id)
    if (!ids.length) return
    const i = ids.indexOf(_activeId)
    const next = e.key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)
    if (ids[next] && ids[next] !== _activeId) selectTicket(ids[next])
  } else if (e.key === 'e' && _currentTk) { e.preventDefault(); tkEditTitle(_currentTk.id) }
  else if (e.key === 'r' && _currentTk) { e.preventDefault(); document.getElementById('reply-input')?.focus() }
}

async function loadProposalsCount() {
  try {
    const { pending } = await window.api.getProposalsCount()
    _proposalsCount = pending || 0
  } catch { _proposalsCount = 0 }
  updateProposalsBadge()
}

async function loadInboxCount() {
  try {
    const { pending } = await window.api.getInboxCount()
    _inboxCount = pending || 0
  } catch { _inboxCount = 0 }
  updateInboxBadge()
}

function updateInboxBadge() {
  const cnt = document.getElementById('tk-inbox-count')
  if (cnt) {
    cnt.style.display = _inboxCount > 0 ? '' : 'none'
    cnt.textContent = _inboxCount
    cnt.classList.toggle('hot', _inboxCount > 0 && _view !== 'inbox')
  }
  window.updateInboxSidebarBadge?.(_inboxCount)
}

function updateProposalsBadge() {
  const btn = document.getElementById('tk-proposals-btn')
  const cnt = document.getElementById('tk-proposals-count')
  if (!btn || !cnt) return
  btn.style.display = _proposalsCount > 0 ? '' : 'none'
  cnt.textContent = _proposalsCount || ''
}

// Stats du pont mail sur 7 jours. Bandeau ambiant, caché si total=0.
async function loadEmailStats() {
  const bar = document.getElementById('tk-mail-stats')
  if (!bar) return
  let stats
  try { stats = await window.api.getEmailStats(7) } catch { return }
  if (!stats || !stats.total) { bar.style.display = 'none'; return }

  const a = stats.by_action || {}
  const propTotal = (a.proposal_created || 0) + (a.proposal_created_no_match || 0)
  const parts = []
  parts.push(`<i class="ti ti-mail" style="font-size:12px;vertical-align:-1px"></i> ${t('tickets.mail_stats.ingested', { n: stats.total })}`)
  if (a.pending_review)     parts.push(`<span style="color:var(--accent);font-weight:500">${t('tickets.mail_stats.pending_review', { n: a.pending_review })}</span>`)
  if (propTotal)            parts.push(t('tickets.mail_stats.proposals',     { n: propTotal }))
  if (a.message_appended)   parts.push(t('tickets.mail_stats.appended',      { n: a.message_appended }))
  if (a.skipped_other)      parts.push(t('tickets.mail_stats.skipped_other', { n: a.skipped_other }))
  if (a.in_queue)           parts.push(`<span style="color:var(--accent)">${t('tickets.mail_stats.in_queue', { n: a.in_queue })}</span>`)
  if (a.skipped_error)      parts.push(`<span style="color:var(--red)">${t('tickets.mail_stats.errors', { n: a.skipped_error })}</span>`)
  bar.innerHTML = parts.join(' <span style="opacity:0.4">·</span> ')
  bar.style.display = ''
}

// ─── Render principal selon _view ───────────────────────────────────────────

function renderMain() {
  const main = document.getElementById('tk-main')
  if (!main) return
  if (_view === 'kanban')     renderKanbanLayout(main)
  else if (_view === 'inbox') renderInboxLayout(main)
  else                        renderListLayout(main)
  renderAdvancedPanel()
  renderActiveChips()
  updateInboxBadge()
}

function updateSubtitle() {
  const el = document.getElementById('tk-subtitle')
  if (!el) return
  if (_view === 'inbox') { el.textContent = _inboxCount ? t('tickets.inbox.subtitle', { n: _inboxCount }) : ''; return }
  const n = applyLocalSearch(_tickets, _localQ).length
  el.textContent = n ? t('tickets.subtitle_count', { n }) : ''
}

function renderListLayout(main) {
  main.innerHTML = `
    <div class="view-split" style="flex:1;min-height:0">
      <div class="ticket-list-col">
        <div class="toolbar" style="padding:8px 10px;gap:6px">
          <div class="search-bar" style="max-width:none;padding:5px 9px">
            <i class="ti ti-search"></i>
            <input id="tk-q" placeholder="${t('tickets.search')}" oninput="filterTickets(this.value)" value="${esc(_localQ)}">
          </div>
          <button class="btn btn-sm ${_showAdvanced || hasActiveAdvanced() ? 'btn-primary' : ''}" id="tk-adv-toggle" onclick="toggleAdvanced()" title="${t('tickets.filters.advanced')}">
            <i class="ti ti-adjustments-horizontal"></i>
          </button>
        </div>
        <div class="tk-tabs">
          ${['all','open','in_progress','auto','resolved','closed'].map(s => `
            <button class="tk-tab ${_filters.status===s?'active':''}" id="tf-${s}"
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
          <span style="font-size:11.5px;color:var(--text-tertiary)">${esc(t('tickets.keys_hint'))}</span>
        </div>
      </div>
    </div>`
  renderList()
  if (_activeId) selectTicket(_activeId)
}

function renderKanbanLayout(main) {
  main.innerHTML = `
    <div class="view-kanban" style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="toolbar" style="padding:8px 12px;gap:6px">
        <div class="search-bar" style="padding:5px 9px">
          <i class="ti ti-search"></i>
          <input id="tk-q" placeholder="${t('tickets.search')}" oninput="filterTickets(this.value)" value="${esc(_localQ)}">
        </div>
        <button class="btn btn-sm ${_showAdvanced || hasActiveAdvanced() ? 'btn-primary' : ''}" id="tk-adv-toggle" onclick="toggleAdvanced()" title="${t('tickets.filters.advanced')}">
          <i class="ti ti-adjustments-horizontal"></i>
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
  if (_activeId) tkOpenDrawer(_activeId)
}

// Filtre local pour réactivité immédiate pendant la frappe. Si le filtre
// local ne trouve rien alors que le backend (qui cherche aussi dans les
// messages / personnes) a renvoyé des tickets, on garde la liste backend.
function applyLocalSearch(tickets, q) {
  if (!q?.trim()) return tickets
  const lower = q.toLowerCase()
  const matched = tickets.filter(tk =>
    tk.title.toLowerCase().includes(lower) ||
    (tk.hostname || '').toLowerCase().includes(lower) ||
    (tk.requester_name || '').toLowerCase().includes(lower) ||
    ticketRef(tk.id).toLowerCase() === lower.replace(/^#/, '')
  )
  return (matched.length === 0 && tickets.length > 0) ? tickets : matched
}

// ─── Kanban ──────────────────────────────────────────────────────────────────

function renderKanbanCards() {
  const visible = applyLocalSearch(_tickets, _localQ)
  const groups = { open: [], in_progress: [], resolved: [] }
  for (const tk of visible) if (groups[tk.status]) groups[tk.status].push(tk)

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
    if (!list.length) body.innerHTML = `<div class="kanban-empty">${t('tickets.kanban.empty')}</div>`
  }
  updateSubtitle()
}

function kanbanCard(tk) {
  const prioColor = tk.priority === 'critical' ? 'var(--red)'
                  : tk.priority === 'high'     ? 'var(--amber)'
                  : tk.priority === 'low'      ? 'var(--text-tertiary)'
                  : '#0d9488'
  const tags = (tk.tags || []).slice(0, 4).map(g => tagChip(g, { compact: true })).join('')
  return `
    <div class="kanban-card ${_activeId === tk.id ? 'kc-active' : ''}" draggable="true"
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
       : esc(s)
}

// ─── Toggle vue ─────────────────────────────────────────────────────────────

async function tkSetView(v) {
  if (v === _view || !VIEWS.includes(v)) return
  _view = v
  writeView(v)
  document.querySelectorAll('#tk-seg .seg-btn').forEach((btn, i) => {
    btn.classList.toggle('active', VIEWS[i] === v)
  })
  if (v !== 'kanban') tkCloseDrawer({ keepActive: true })
  if (v === 'inbox') { _currentTk = null }
  renderMain()
}

async function tkKanbanGotoList(status) {
  _filters.status = status
  _view = 'list'
  writeView('list')
  writeFiltersToHash()
  document.querySelectorAll('#tk-seg .seg-btn').forEach((btn, i) => btn.classList.toggle('active', i === 0))
  await loadTickets()
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
  e.currentTarget?.classList?.add('kanban-col-hover')
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
  tk.status = newStatus
  if (newStatus === 'resolved') tk.resolved_at = new Date().toISOString()
  renderKanbanCards()
  try {
    const updated = await window.api.updateTicket(ticketId, { status: newStatus })
    Object.assign(tk, updated, { tags: tk.tags })
  } catch {
    tk.status = oldStatus
    if (oldStatus !== 'resolved') tk.resolved_at = null
    renderKanbanCards()
    showToast(t('error.generic'), 'error')
  }
}

// ─── Drawer latéral (Kanban) ────────────────────────────────────────────────

async function tkOpenDrawer(ticketId) {
  _activeId = ticketId
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
        <span>${esc(t('tickets.drawer.hint'))}</span>
        <button class="btn btn-sm" onclick="tkCloseDrawer()" title="${t('btn.close')}"><i class="ti ti-x"></i> ${t('btn.close')}</button>
      </div>
      <div class="td-content" id="ticket-drawer-content">
        <div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div>
      </div>`
    document.body.appendChild(drawer)
    document.addEventListener('click', drawerOutsideClick, true)
    document.addEventListener('keydown', drawerEscHandler)
  }
  drawer.classList.add('open')
  document.querySelectorAll('.kanban-card').forEach(c => c.classList.remove('kc-active'))
  try {
    const tk = await window.api.getTicket(ticketId)
    renderDetail(tk, document.getElementById('ticket-drawer-content'))
    renderKanbanCards()
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function tkCloseDrawer({ keepActive = false } = {}) {
  const drawer = document.getElementById('ticket-drawer')
  if (drawer) drawer.classList.remove('open')
  if (!keepActive) {
    _activeId = null
    _currentTk = null
    if (window.location.hash.startsWith('#/tickets/')) {
      try { history.replaceState(null, '', '#/tickets' + (_view !== 'list' ? `?view=${_view}` : '')) } catch {}
    }
    if (_view === 'kanban') renderKanbanCards()
  }
}

function drawerOutsideClick(e) {
  const drawer = document.getElementById('ticket-drawer')
  if (!drawer || !drawer.classList.contains('open')) return
  if (drawer.contains(e.target)) return
  if (e.target.closest('#modal-overlay')) return
  if (e.target.closest('.kanban-card')) return
  tkCloseDrawer()
}

function drawerEscHandler(e) {
  if (e.key === 'Escape') {
    const drawer = document.getElementById('ticket-drawer')
    if (drawer?.classList.contains('open') && document.getElementById('modal-overlay')?.classList.contains('hidden')) tkCloseDrawer()
  }
}

// ─── Styles Kanban (injectés une fois) ──────────────────────────────────────

function ensureKanbanStyles() {
  if (document.getElementById('kanban-styles')) return
  const s = document.createElement('style')
  s.id = 'kanban-styles'
  s.textContent = `
    .kanban-col { display:flex; flex-direction:column; background:var(--bg-secondary); border:0.5px solid var(--border); border-radius:var(--radius-md); min-height:0; overflow:hidden; transition: background 0.15s; }
    .kanban-col-hover { background:var(--bg-tertiary); outline:2px dashed var(--blue); outline-offset:-4px; }
    .kanban-col-header { padding:8px 12px; border-bottom:0.5px solid var(--border); display:flex; justify-content:space-between; align-items:center; font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-secondary); background:var(--bg-primary); }
    .kanban-col-count { background:var(--bg-tertiary); color:var(--text-secondary); padding:1px 8px; border-radius:10px; font-size:11px; font-weight:500; }
    .kanban-col-body { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
    .kanban-empty { color:var(--text-tertiary); font-size:12px; text-align:center; padding:20px 8px; }
    .kanban-overflow { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; font-size:11px; color:var(--text-tertiary); }
    .kanban-card { background:var(--bg-primary); border:0.5px solid var(--border); border-radius:var(--radius-md); cursor:pointer; display:flex; overflow:hidden; transition: box-shadow 0.15s, border-color 0.15s; flex-shrink:0; }
    .kanban-card:hover { box-shadow: var(--shadow-sm); border-color: var(--blue); }
    .kanban-card.kc-active { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
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
  if (_view === 'kanban')     renderKanbanCards()
  else if (_view === 'list')  renderList()
}

// ─── Liste ───────────────────────────────────────────────────────────────────

function renderList() {
  const el = document.getElementById('ticket-list')
  updateSubtitle()
  if (!el) return
  const filtered = applyLocalSearch(_tickets, _localQ)
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem"><i class="ti ti-ticket"></i><p>${t('tickets.empty')}</p></div>`
    return
  }
  el.innerHTML = filtered.map(tk => ticketItem(tk)).join('')
  el.querySelector('.ticket-item.active')?.scrollIntoView({ block: 'nearest' })
}

function ticketItem(tk) {
  const active = _activeId === tk.id ? ' active' : ''
  const tagsHtml = (tk.tags || []).slice(0, 4).map(g => tagChip(g, { compact: true })).join('')
  const prioCls = tk.priority === 'critical' || tk.priority === 'high' ? ` prio-${tk.priority}` : ''
  return `
    <div class="ticket-item${active}${prioCls}" onclick="selectTicket('${tk.id}')" data-id="${tk.id}">
      <div class="tk-header">
        <span class="tk-title">${awaitingDot(tk)}${esc(tk.title)}</span>
        <span class="tk-time">${displayWhen(tk)}</span>
      </div>
      <div class="tk-meta">
        ${statusPill(tk.status)}
        ${prioPill(tk.priority)}
        ${tk.requester_name ? `<span title="${esc(t('tickets.info.requester'))}: ${esc(tk.requester_name)}"><i class="ti ti-user"></i>${esc(shortName(tk.requester_name))}</span>` : ''}
        ${tk.hostname ? `<span title="${esc(t('tickets.info.device'))}"><i class="ti ti-device-laptop"></i>${esc(tk.hostname)}</span>` : ''}
        ${tk.assigned_to_name
          ? `<span title="${esc(t('tickets.info.assignee'))}: ${esc(tk.assigned_to_name)}"><i class="ti ti-user-check"></i>${esc(shortName(tk.assigned_to_name))}</span>`
          : (tk.status === 'open' ? `<span style="color:var(--text-tertiary);font-style:italic"><i class="ti ti-user-off"></i>${esc(t('tickets.unassigned'))}</span>` : '')}
        ${tk.is_auto ? `<span title="Auto"><i class="ti ti-robot"></i></span>` : ''}
      </div>
      ${tagsHtml ? `<div class="tk-tags">${tagsHtml}</div>` : ''}
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
  const expected = `#/tickets/${id}`
  if (window.location.hash !== expected) {
    try { history.replaceState(null, '', expected) } catch {}
  }
  renderList()
  const detail = document.getElementById('ticket-detail')
  if (detail) detail.innerHTML = `<div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div>`
  try {
    const tk = await window.api.getTicket(id)
    // Ticket fusionné → redirige vers la cible.
    if (tk.merged_into) {
      showToast(t('tickets.merge.redirected').replace('{target}', ticketRef(tk.merged_into)), 'info')
      return selectTicket(tk.merged_into)
    }
    if (_activeId !== id) return   // l'utilisateur a cliqué ailleurs entre-temps
    renderDetail(tk)
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

function getDetailContainer() {
  if (_view === 'kanban') return document.getElementById('ticket-drawer-content')
  return document.getElementById('ticket-detail')
}

function clearDetail() {
  _currentTk = null
  const detail = getDetailContainer()
  if (detail) detail.innerHTML = `<div class="ticket-detail-empty"><i class="ti ti-ticket" style="font-size:32px"></i><span>${t('tickets.select_hint')}</span></div>`
  if (_view === 'kanban') tkCloseDrawer()
}

// Un message « comment » dont l'auteur est un expéditeur de mail entrant du
// ticket a été REÇU par mail ; les autres comments ont été envoyés par mail.
function isInboundMail(m, tk) {
  if (m.type !== 'comment') return false
  const authors = tk.mail_authors || []
  if (authors.includes(m.author)) return true
  if (tk.requester_name && m.author === tk.requester_name) return true
  if ((tk.related_users || []).some(u => u.display_name === m.author && u.entra_id !== tk.assigned_to_entra_id)) return true
  return /@/.test(m.author || '') || m.author === 'Email'
}

function renderDetail(tk, container) {
  const detail = container || getDetailContainer()
  if (!detail) return
  _currentTk = tk
  const open     = tk.status === 'open'
  const resolved = tk.status === 'resolved'
  const closed   = tk.status === 'closed'
  const canMail  = !!tk.has_inbound_mail
  const mode     = canMail && _composerMode === 'mail' ? 'mail' : 'note'

  // Actions principales selon l'état :
  //   open        → Prendre en charge + Résoudre
  //   in_progress → Résoudre
  //   resolved    → Rouvrir + Archiver
  //   closed      → Désarchiver
  let actions = ''
  if (closed) {
    actions = `<button class="btn btn-sm" onclick="unarchiveTicket('${tk.id}')"><i class="ti ti-archive-off"></i> ${t('tickets.unarchive')}</button>`
  } else if (resolved) {
    actions = `
      <button class="btn btn-sm" onclick="reopenTicket('${tk.id}')"><i class="ti ti-refresh"></i> ${t('tickets.reopen')}</button>
      <button class="btn btn-sm" onclick="archiveTicket('${tk.id}')"><i class="ti ti-archive"></i> ${t('tickets.archive')}</button>`
  } else if (open) {
    actions = `
      <button class="btn btn-sm" onclick="takeInProgressTicket('${tk.id}')"><i class="ti ti-player-play"></i> ${t('tickets.take_in_progress')}</button>
      <button class="btn btn-sm btn-primary" onclick="resolveTicket('${tk.id}')"><i class="ti ti-check"></i> ${t('tickets.resolve')}</button>`
  } else {
    actions = `<button class="btn btn-sm btn-primary" onclick="resolveTicket('${tk.id}')"><i class="ti ti-check"></i> ${t('tickets.resolve')}</button>`
  }

  const requesterProp = tk.requester_name
    ? `<span class="td-prop clickable" onclick="tkOpenRequesterPicker('${tk.id}')" title="${esc(t('tickets.info.requester'))}"><i class="ti ti-user"></i>${userLink(tk.user_id, tk.requester_name)}${tk.requester_email ? `<span class="lbl">${esc(tk.requester_email)}</span>` : ''}</span>`
    : `<span class="td-prop clickable empty" onclick="tkOpenRequesterPicker('${tk.id}')"><i class="ti ti-user-plus"></i>${esc(t('tickets.no_requester'))}</span>`
  const assigneeProp = tk.assigned_to_name
    ? `<span class="td-prop clickable" onclick="tkOpenAssigneePickerOnTicket('${tk.id}')" title="${esc(t('tickets.info.assignee'))}"><span class="av">${esc(initialsOf(tk.assigned_to_name))}</span>${userLink(tk.assigned_to_entra_id, tk.assigned_to_name)}</span>`
    : `<span class="td-prop clickable empty" onclick="tkAssignSelf('${tk.id}')" title="${esc(t('tickets.assign_self'))}"><i class="ti ti-user-check"></i>${esc(t('tickets.unassigned'))} · ${esc(t('tickets.assign_self'))}</span>`
  const deviceProp = tk.hostname
    ? `<span class="td-prop" title="${esc(t('tickets.info.device'))}"><i class="ti ti-device-laptop"></i>${deviceLink(tk.device_id, tk.hostname)}</span>`
    : (window.OPALE.moduleEnabled('inventory') ? `<span class="td-prop clickable empty" onclick="tkOpenDevicePicker('${tk.id}')"><i class="ti ti-device-laptop"></i>${esc(t('tickets.no_device'))}</span>` : '')

  const messages = tk.messages || []
  let lastDay = ''
  const threadHtml = messages.map(m => {
    const k = dayKey(m.created_at)
    const sep = k && k !== lastDay ? `<div class="msg-daysep">${esc(dayLabel(m.created_at))}</div>` : ''
    lastDay = k || lastDay
    return sep + renderMsg(m, tk)
  }).join('')

  const desc = tk.description ? cleanLegacyHtml(tk.description) : ''
  const descLong = desc.length > 600

  detail.innerHTML = `
    <div class="ticket-detail-header">
      <div class="td-topline">
        <span class="td-ref" onclick="tkCopyRef('${tk.id}')" title="${esc(t('tickets.ref.copy_hint'))}">#${ticketRef(tk.id)}</span>
        ${sourceChip(tk)}
        <span>${esc(t('tickets.info.created'))} ${whenHtml(tk.created_at)}${tk.created_by_name ? ` · ${esc(tk.created_by_name)}` : ''}</span>
        ${tk.updated_at && tk.updated_at !== tk.created_at ? `<span>· ${esc(t('tickets.info.updated'))} ${whenHtml(tk.updated_at)}</span>` : ''}
        <span style="margin-left:auto;display:inline-flex;gap:4px">
          <button class="btn btn-sm btn-ghost" onclick="tkCopyLink('${tk.id}')" title="${esc(t('tickets.link.copy'))}"><i class="ti ti-link"></i></button>
          <button class="btn btn-sm btn-ghost" onclick="tkOpenMergeModal('${tk.id}')" title="${esc(t('tickets.merge.action'))}"><i class="ti ti-arrows-join"></i></button>
        </span>
      </div>
      <div class="td-titlerow" id="td-titlerow">
        <h2 class="ticket-detail-title" id="td-title" ondblclick="tkEditTitle('${tk.id}')" title="${esc(t('tickets.title.edit_hint'))}">${esc(tk.title)}
          <button class="btn btn-sm btn-ghost" style="vertical-align:middle;padding:1px 5px" onclick="tkEditTitle('${tk.id}')" title="${esc(t('tickets.title.edit'))}"><i class="ti ti-pencil"></i></button>
        </h2>
        <div class="ticket-detail-actions">${actions}</div>
      </div>
      <div class="td-props">
        <span class="td-prop clickable" onclick="tkOpenStatusMenu('${tk.id}')" title="${esc(t('tickets.status.change'))}">${statusPill(tk.status)}<i class="ti ti-chevron-down" style="font-size:11px"></i></span>
        <span class="td-prop clickable" onclick="tkOpenPriorityPicker('${tk.id}')" title="${esc(t('tickets.priority.change'))}">${prioPill(tk.priority)}<i class="ti ti-chevron-down" style="font-size:11px"></i></span>
        ${requesterProp}
        ${assigneeProp}
        ${deviceProp}
      </div>
    </div>
    <div class="ticket-body-grid">
      <div class="ticket-thread-col">
        <div class="desc-box" id="td-desc" ${desc ? '' : 'style="display:none"'}>
          <div class="desc-label" style="display:flex;align-items:center;justify-content:space-between">
            <span>${esc(t('tickets.description'))}</span>
            <button class="btn btn-sm btn-ghost" style="padding:0 4px;font-size:11px" onclick="tkEditDescription('${tk.id}')"><i class="ti ti-pencil"></i> ${esc(t('btn.edit'))}</button>
          </div>
          <div id="td-desc-text" class="${descLong ? 'msg-content collapsed' : ''}" style="background:none;border:none;padding:0">${esc(desc)}</div>
          ${descLong ? `<span class="msg-more" onclick="tkToggleMsg(this, 'td-desc-text')">${esc(t('tickets.msg.show_more'))}</span>` : ''}
        </div>
        ${!desc ? `<div style="padding:10px 20px 0"><button class="btn btn-sm btn-ghost" style="font-size:11.5px" onclick="tkEditDescription('${tk.id}')"><i class="ti ti-plus"></i> ${esc(t('tickets.description.add'))}</button></div>` : ''}
        <div class="messages" id="msg-thread">
          ${threadHtml || `<div style="text-align:center;color:var(--text-tertiary);font-size:12px;padding:20px">${esc(t('tickets.msg.none'))}</div>`}
        </div>
        ${!closed ? `
          <div class="reply-box">
            <div class="reply-modes">
              <button class="reply-mode ${mode==='note'?'active':''}" data-mode="note" onclick="tkSetComposerMode('note')" title="${esc(t('tickets.composer.note_hint'))}"><i class="ti ti-note"></i> ${esc(t('tickets.composer.note'))}</button>
              <button class="reply-mode ${mode==='mail'?'active':''}" data-mode="mail" onclick="tkSetComposerMode('mail')" ${canMail ? '' : `disabled title="${esc(t('tickets.send_by_mail.no_inbound'))}" style="opacity:0.5;cursor:not-allowed"`}><i class="ti ti-mail-forward"></i> ${esc(t('tickets.composer.mail'))}${tk.requester_email && canMail ? ` <span style="opacity:0.75">→ ${esc(tk.requester_email)}</span>` : ''}</button>
              <span class="reply-hint" id="reply-hint">${esc(mode === 'mail' ? t('tickets.composer.mail_hint') : t('tickets.composer.note_hint'))}</span>
            </div>
            <textarea class="reply-input ${mode==='mail'?'mode-mail':''}" id="reply-input" placeholder="${esc(mode === 'mail' ? t('tickets.composer.mail_placeholder') : t('tickets.composer.note_placeholder'))}" onkeydown="tkComposerKey(event, '${tk.id}')"></textarea>
            <div class="reply-actions">
              <button class="btn btn-sm" id="tk-ai-btn" onclick="tkAiSuggest('${tk.id}')" title="${esc(t('tickets.ai.hint'))}">
                <i class="ti ti-sparkles"></i> ${t('tickets.ai.suggest')}
              </button>
              <span style="flex:1"></span>
              <span style="font-size:11px;color:var(--text-tertiary)">⌘/Ctrl + ↵</span>
              <button class="btn btn-sm ${mode==='mail' ? 'btn-primary' : ''}" id="tk-send-btn" onclick="sendReply('${tk.id}')">
                <i class="ti ${mode==='mail' ? 'ti-send' : 'ti-note'}"></i> ${esc(mode === 'mail' ? t('tickets.composer.send_mail') : t('tickets.composer.send_note'))}
              </button>
            </div>
          </div>
        ` : ''}
      </div>
      <div class="ticket-info-col">
        ${canMail ? `
        <div class="info-mail">
          <i class="ti ti-mail-check"></i>
          <div>
            <div style="font-weight:600">${esc(t('tickets.mail.linked_title'))}</div>
            <div style="opacity:0.9">${esc(t('tickets.mail.linked_desc', { n: tk.inbound_mail_count || 0 }))}</div>
          </div>
        </div>` : ''}

        <div class="info-section">
          <div class="info-section-title">
            <span>${t('tickets.info.related_users')}</span>
            <button class="btn btn-sm btn-ghost" onclick="tkOpenRequesterPicker('${tk.id}')" title="${esc(t('tickets.related_users.add'))}"><i class="ti ti-plus"></i></button>
          </div>
          ${renderRelatedUsers(tk)}
        </div>

        ${window.OPALE.moduleEnabled('inventory') ? `
        <div class="info-section">
          <div class="info-section-title">
            <span>${t('tickets.info.related_devices')}</span>
            <button class="btn btn-sm btn-ghost" onclick="tkOpenDevicePicker('${tk.id}')" title="${esc(t('tickets.related_devices.add'))}"><i class="ti ti-plus"></i></button>
          </div>
          ${renderRelatedDevices(tk)}
        </div>` : ''}

        <div class="info-section">
          <div class="info-section-title">
            <span>${t('tickets.info.tags')}</span>
            <button class="btn btn-sm btn-ghost" onclick="tkOpenTagPicker('${tk.id}')" title="${esc(t('tickets.tags.add'))}"><i class="ti ti-plus"></i></button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${(tk.tags || []).length
              ? tk.tags.map(g => tagChip(g, { onRemove: `tkRemoveTagFromTicket('${tk.id}','${g.id}')` })).join('')
              : `<span class="info-empty">${t('tickets.no_tags')}</span>`}
          </div>
        </div>

        <div class="info-section">
          <div class="info-section-title">
            <span>${t('tickets.info.attachments')}</span>
            <button class="btn btn-sm btn-ghost" onclick="document.getElementById('tk-att-input-${tk.id}').click()" title="${esc(t('tickets.attachments.add'))}"><i class="ti ti-paperclip"></i></button>
          </div>
          <input type="file" id="tk-att-input-${tk.id}" style="display:none" onchange="tkUploadAttachment('${tk.id}', this)">
          ${renderAttachments(tk)}
        </div>

        <div class="info-section">
          <div class="info-section-title"><span>${t('tickets.info.details')}</span></div>
          <div class="info-row"><span class="label">${t('tickets.info.ref')}</span><span class="value" style="font-family:monospace">#${ticketRef(tk.id)}</span></div>
          <div class="info-row"><span class="label">${t('tickets.info.created')}</span><span class="value">${whenHtml(tk.created_at)}</span></div>
          ${tk.created_by_name ? `<div class="info-row"><span class="label">${t('tickets.info.by')}</span><span class="value">${esc(tk.created_by_name)}</span></div>` : ''}
          ${tk.updated_at ? `<div class="info-row"><span class="label">${t('tickets.info.updated')}</span><span class="value">${whenHtml(tk.updated_at)}</span></div>` : ''}
          ${resolved && tk.resolved_at ? `<div class="info-row"><span class="label">${t('tickets.info.resolved')}</span><span class="value">${whenHtml(tk.resolved_at)}</span></div>` : ''}
          ${tk.source ? `<div class="info-row"><span class="label">${t('tickets.info.source')}</span><span class="value">${esc(t('tickets.source.' + tk.source) === 'tickets.source.' + tk.source ? tk.source : t('tickets.source.' + tk.source))}</span></div>` : ''}
          ${canMail ? `<div class="info-row"><span class="label">${t('tickets.info.mails')}</span><span class="value">${tk.inbound_mail_count || 0} ↓ · ${tk.outbound_mail_count || 0} ↑</span></div>` : ''}
        </div>
      </div>
    </div>`

  const thread = document.getElementById('msg-thread')
  if (thread) thread.scrollTop = thread.scrollHeight
}

function renderRelatedUsers(tk) {
  const users = Array.isArray(tk.related_users) ? tk.related_users : []
  if (!users.length) return `<span class="info-empty">${t('tickets.no_requester')}</span>`
  return users.map(u => {
    const isReq = u.role === 'requester'
    return `<div class="info-item">
      <div class="main">
        ${userLink(u.entra_id, u.display_name || u.entra_id)}
        ${isReq ? `<span class="badge badge-green" style="font-size:9px;padding:1px 5px">${esc(t('tickets.role.requester'))}</span>` : ''}
      </div>
      ${u.email ? `<span class="sub" title="${esc(u.email)}"><a href="mailto:${esc(u.email)}" style="color:inherit" onclick="event.stopPropagation()"><i class="ti ti-mail"></i></a></span>` : ''}
      <button class="rm" onclick="tkRemoveUser('${tk.id}',${jsArg(u.entra_id)})" title="${esc(t('tickets.related_users.remove'))}"><i class="ti ti-x"></i></button>
    </div>`
  }).join('')
}

function renderRelatedDevices(tk) {
  const devs = Array.isArray(tk.related_devices) ? tk.related_devices : []
  if (!devs.length) return `<span class="info-empty">${t('tickets.no_device')}</span>`
  return devs.map(d => `<div class="info-item">
    <div class="main"><i class="ti ti-device-laptop" style="color:var(--text-tertiary)"></i>${deviceLink(d.id, d.hostname || d.id)}</div>
    <button class="rm" onclick="tkRemoveDevice('${tk.id}','${d.id}')" title="${esc(t('tickets.related_devices.remove'))}"><i class="ti ti-x"></i></button>
  </div>`).join('')
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

function renderAttachments(tk) {
  const atts = Array.isArray(tk.attachments) ? tk.attachments : []
  if (!atts.length) return `<span class="info-empty">${t('tickets.attachments.none')}</span>`
  return atts.map(a => `<div class="info-item">
    <div class="main" style="cursor:pointer" onclick="tkDownloadAttachment('${tk.id}','${a.id}', this.dataset.fn)" data-fn="${esc(a.filename)}" title="${esc(a.filename)}">
      <i class="ti ti-paperclip" style="color:var(--text-tertiary)"></i><a>${esc(a.filename)}</a>
      <span class="sub">${formatBytes(a.size_bytes)}</span>
    </div>
    <button class="rm" onclick="tkRemoveAttachment('${tk.id}','${a.id}')" title="${esc(t('tickets.attachments.remove'))}"><i class="ti ti-x"></i></button>
  </div>`).join('')
}

const MSG_COLLAPSE_CHARS = 1400

function renderMsg(m, tk) {
  const when = `<span class="msg-time">${whenHtml(m.created_at)}</span>`
  if (m.type === 'system') {
    return `<div class="msg">
      <div class="msg-av av-sys"><i class="ti ti-info-circle" style="font-size:14px"></i></div>
      <div class="msg-bubble">
        <div class="msg-author">${esc(m.author)}${when}</div>
        <div class="msg-content sys">${esc(m.content)}</div>
      </div>
    </div>`
  }
  if (m.type === 'ai_suggestion') {
    return `<div class="msg">
      <div class="msg-av av-ai"><i class="ti ti-sparkles" style="font-size:14px"></i></div>
      <div class="msg-bubble">
        <div class="msg-author">${esc(m.author)}<span class="msg-badge msg-badge-ai">${esc(t('tickets.ai.badge'))}</span>${when}</div>
        <div class="msg-content ai-suggestion">${esc(m.content)}</div>
        <div class="msg-actions">
          <button class="btn btn-sm" data-content="${esc(m.content)}" onclick="tkUseSuggestion(this)" title="${esc(t('tickets.ai.use_hint'))}">
            <i class="ti ti-corner-up-left"></i> ${esc(t('tickets.ai.use'))}
          </button>
          <button class="btn btn-sm btn-ghost" onclick="tkDeleteSuggestion('${tk.id}','${m.id}')" title="${esc(t('tickets.ai.discard'))}">
            <i class="ti ti-x"></i>
          </button>
        </div>
      </div>
    </div>`
  }

  const inbound = isInboundMail(m, tk)
  let stateBadge = ''
  let mailAction = ''
  let contentClass = ''
  let avClass = ''
  if (m.type === 'internal_note') {
    contentClass = 'internal-note'
    stateBadge = `<span class="msg-badge msg-badge-internal" title="${esc(t('tickets.msg.internal_hint'))}"><i class="ti ti-lock"></i> ${esc(t('tickets.msg.internal'))}</span>`
    if (tk?.has_inbound_mail) {
      mailAction = `<button class="btn btn-sm msg-send-mail" onclick="sendMsgByMail('${tk.id}','${m.id}')" title="${esc(t('tickets.msg.send_by_mail'))}">
        <i class="ti ti-mail-forward"></i> ${esc(t('tickets.msg.send_by_mail'))}
      </button>`
    }
  } else if (m.type === 'resolution') {
    contentClass = 'resolution'
  } else if (m.type === 'comment' && inbound) {
    contentClass = 'mail-in'
    avClass = 'av-mail'
    stateBadge = `<span class="msg-badge msg-badge-in"><i class="ti ti-mail-down"></i> ${esc(t('tickets.msg.received_by_mail'))}</span>`
  } else if (m.type === 'comment' && m.outbound_failed_at) {
    stateBadge = `<span class="msg-badge msg-badge-failed" title="${esc(m.outbound_error || t('tickets.msg.send_failed'))}"><i class="ti ti-mail-x"></i> ${esc(t('tickets.msg.send_failed'))}</span>`
    mailAction = `<button class="btn btn-sm msg-send-mail" onclick="tkRetrySend('${tk.id}','${m.id}')" title="${esc(t('tickets.msg.retry_send'))}">
      <i class="ti ti-refresh"></i> ${esc(t('tickets.msg.retry_send'))}
    </button>`
  } else if (m.type === 'comment' && !m.email_sent_at) {
    stateBadge = `<span class="msg-badge msg-badge-sending"><i class="ti ti-mail-fast"></i> ${esc(t('tickets.msg.sending'))}</span>`
  } else if (m.type === 'comment' && m.email_sent_at) {
    stateBadge = `<span class="msg-badge msg-badge-sent"><i class="ti ti-mail-check"></i> ${esc(t('tickets.msg.sent_by_mail'))}</span>`
  }

  const long = (m.content || '').length > MSG_COLLAPSE_CHARS
  const cid = `msg-c-${m.id}`
  return `<div class="msg" id="msg-${m.id}">
    <div class="msg-av ${avClass}">${esc(initialsOf(m.author))}</div>
    <div class="msg-bubble">
      <div class="msg-author">${esc(m.author)}${stateBadge}${when}</div>
      <div class="msg-content ${contentClass} ${long ? 'collapsed' : ''}" id="${cid}">${esc(m.content)}</div>
      ${long ? `<span class="msg-more" onclick="tkToggleMsg(this, '${cid}')">${esc(t('tickets.msg.show_more'))}</span>` : ''}
      ${mailAction ? `<div class="msg-actions">${mailAction}</div>` : ''}
    </div>
  </div>`
}

function tkToggleMsg(link, id) {
  const el = document.getElementById(id)
  if (!el) return
  const collapsed = el.classList.toggle('collapsed')
  link.textContent = collapsed ? t('tickets.msg.show_more') : t('tickets.msg.show_less')
}

// ─── Édition titre / description ─────────────────────────────────────────────

function tkEditTitle(id) {
  const row = document.getElementById('td-titlerow')
  const tk = _currentTk
  if (!row || !tk || tk.id !== id || document.getElementById('td-title-input')) return
  row.innerHTML = `
    <div style="flex:1;display:flex;gap:6px;align-items:center">
      <input class="form-input" id="td-title-input" value="${esc(tk.title)}" maxlength="200" style="font-size:15px;font-weight:600"
        onkeydown="if(event.key==='Enter'){event.preventDefault();tkSaveTitle('${id}')}else if(event.key==='Escape'){tkCancelEditTitle()}">
      <button class="btn btn-sm btn-primary" onclick="tkSaveTitle('${id}')"><i class="ti ti-check"></i> ${t('btn.save')}</button>
      <button class="btn btn-sm" onclick="tkCancelEditTitle()">${t('btn.cancel')}</button>
    </div>`
  const input = document.getElementById('td-title-input')
  input.focus(); input.select()
}

function tkCancelEditTitle() {
  if (_currentTk) renderDetail(_currentTk)
}

async function tkSaveTitle(id) {
  const title = document.getElementById('td-title-input')?.value?.trim()
  if (!title) { showToast(t('tickets.new.title_required'), 'error'); return }
  if (title === _currentTk?.title) { tkCancelEditTitle(); return }
  try {
    await window.api.updateTicket(id, { title })
    await refreshTicket(id)
    showToast(t('tickets.toast.renamed'), 'success')
  } catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
}

function tkEditDescription(id) {
  const tk = _currentTk
  if (!tk || tk.id !== id) return
  showModal(`
    <div class="modal-title">${t('tickets.description.edit_title')}</div>
    <textarea class="form-textarea" id="td-desc-input" style="min-height:220px" placeholder="${esc(t('tickets.new.placeholder_desc'))}">${esc(cleanLegacyHtml(tk.description || ''))}</textarea>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="tkSaveDescription('${id}')">${t('btn.save')}</button>
    </div>`)
  setTimeout(() => document.getElementById('td-desc-input')?.focus(), 50)
}

async function tkSaveDescription(id) {
  const description = document.getElementById('td-desc-input')?.value ?? ''
  try {
    await window.api.updateTicket(id, { description })
    closeModal()
    await refreshTicket(id)
    showToast(t('tickets.toast.description_saved'), 'success')
  } catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
}

async function tkCopyRef(id) {
  try { await navigator.clipboard.writeText(`[Opale #${ticketRef(id)}]`); showToast(t('tickets.ref.copied'), 'success') }
  catch { showToast(t('error.generic'), 'error') }
}
async function tkCopyLink(id) {
  const url = `${location.origin}${location.pathname.replace(/mobile\.html$/, '')}#/tickets/${id}`
  try { await navigator.clipboard.writeText(url); showToast(t('tickets.link.copied'), 'success') }
  catch { showToast(t('error.generic'), 'error') }
}

// Menu de statut : toutes les transitions depuis le bandeau de propriétés.
function tkOpenStatusMenu(id) {
  const current = _currentTk?.id === id ? _currentTk.status : null
  const opts = [
    ['open',        'ti-circle',        t('tickets.status.open')],
    ['in_progress', 'ti-player-play',   t('tickets.status.in_progress')],
    ['resolved',    'ti-check',         t('tickets.status.resolved')],
    ['closed',      'ti-archive',       t('tickets.status.closed')],
  ]
  showModal(`
    <div class="modal-title">${t('tickets.status.picker_title')}</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${opts.map(([v, icon, label]) => `
        <button class="btn ${v === current ? 'btn-primary' : ''}" style="justify-content:flex-start" onclick="tkSetStatus('${id}','${v}')">
          <i class="ti ${icon}"></i> ${esc(label)}
          ${v === current ? `<span style="margin-left:auto;font-size:11px;opacity:0.8">(${t('tickets.priority.current')})</span>` : ''}
        </button>`).join('')}
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
}

async function tkSetStatus(id, status) {
  closeModal()
  if (status === 'closed')   return archiveTicket(id)
  if (status === 'resolved') return resolveTicket(id)
  if (status === 'in_progress') return takeInProgressTicket(id)
  return reopenTicket(id)
}

// ─── Composer ────────────────────────────────────────────────────────────────

function tkSetComposerMode(mode) {
  if (mode === 'mail' && !_currentTk?.has_inbound_mail) return
  _composerMode = mode
  const draft = document.getElementById('reply-input')?.value || ''
  if (_currentTk) renderDetail(_currentTk)
  const input = document.getElementById('reply-input')
  if (input) { input.value = draft; input.focus() }
}

function tkComposerKey(e, id) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendReply(id) }
}

// Envoi depuis le composer : note interne (défaut) ou réponse par mail
// (note créée puis basculée en comment à envoyer, en un seul geste).
async function sendReply(id) {
  const input = document.getElementById('reply-input')
  const content = input?.value?.trim()
  if (!content) return
  const mail = _composerMode === 'mail' && _currentTk?.has_inbound_mail
  const btn = document.getElementById('tk-send-btn')
  if (btn) btn.disabled = true
  try {
    const msg = await window.api.addMessage(id, { content })
    if (mail) await window.api.sendMessageByMail(id, msg.id)
    input.value = ''
    await refreshTicket(id)
    showToast(mail ? t('tickets.toast.mail_queued') : t('tickets.toast.note_added'), 'success')
  } catch (err) {
    if (btn) btn.disabled = false
    if (err?.status === 409) showToast(t('tickets.send_by_mail.no_inbound'), 'error')
    else showToast(err?.body?.error || t('error.generic'), 'error')
  }
}

// ─── Assistant IA ─────────────────────────────────────────────────────────────

async function tkAiSuggest(id) {
  const btn = document.getElementById('tk-ai-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> ${t('tickets.ai.generating')}` }
  try {
    await window.api.aiSuggest(id)
    await refreshTicket(id)
    const thread = document.getElementById('msg-thread')
    if (thread) thread.scrollTop = thread.scrollHeight
  } catch (err) {
    showToast(err?.body?.error || t('tickets.ai.failed'), 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-sparkles"></i> ${t('tickets.ai.suggest')}` }
  }
}

function tkUseSuggestion(btn) {
  const input = document.getElementById('reply-input')
  if (!input) return
  input.value = btn.dataset.content || ''
  input.focus()
  input.scrollIntoView({ block: 'nearest' })
}

async function tkDeleteSuggestion(ticketId, msgId) {
  try {
    await window.api.deleteTicketMessage(ticketId, msgId)
    await refreshTicket(ticketId)
  } catch { showToast(t('error.generic'), 'error') }
}

// ─── Actions sur ticket ──────────────────────────────────────────────────────

async function sendMsgByMail(ticketId, msgId) {
  if (!confirm(t('tickets.send_by_mail.confirm'))) return
  try {
    await window.api.sendMessageByMail(ticketId, msgId)
    const tk = await window.api.getTicket(ticketId)
    renderDetail(tk)
  } catch (err) {
    if (err?.status === 409) showToast(t('tickets.send_by_mail.no_inbound'), 'error')
    else showToast(t('error.generic'), 'error')
  }
}

// Passe le ticket en cours (open → in_progress). Pratique sur les tickets
// auto-créés via le pipeline mail : on lit la proposition, on accepte le
// ticket (status='open'), puis on clique "Prendre en charge" pour signaler
// au requester que c'est traité.
async function takeInProgressTicket(id) {
  try {
    await window.api.updateTicket(id, { status: 'in_progress' })
    const tk = await window.api.getTicket(id)
    const idx = _tickets.findIndex(t => t.id === id)
    if (idx !== -1) _tickets[idx].status = 'in_progress'
    renderListOrKanban()
    renderDetail(tk)
    showToast(t('tickets.toast.in_progress'), 'success')
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

// Archive : ticket clos. Sort des tabs Tous/Ouverts/En cours/Résolus,
// reste accessible via le tab "Archives". Distinct de resolved : on garde
// l'info "résolu" en historique mais on enlève le ticket de la circulation.
async function archiveTicket(id) {
  try {
    await window.api.updateTicket(id, { status: 'closed' })
    // Le ticket disparaît du tab courant (si ce n'est pas Archives). On
    // l'enlève de la liste locale pour éviter un flicker avant le refetch.
    _tickets = _tickets.filter(t => t.id !== id)
    if (_activeId === id) _activeId = null
    renderListOrKanban()
    clearDetail()
    showToast(t('tickets.toast.archived'), 'success')
  } catch {
    showToast(t('error.generic'), 'error')
  }
}

// Désarchive : ticket repassé à 'resolved' (pas à 'open' — il était clos
// donc le boulot était fait, on le remet dans les Résolus).
async function unarchiveTicket(id) {
  try {
    await window.api.updateTicket(id, { status: 'resolved' })
    _tickets = _tickets.filter(t => t.id !== id)  // sortir du tab Archives
    if (_activeId === id) _activeId = null
    renderListOrKanban()
    clearDetail()
    showToast(t('tickets.toast.unarchived'), 'info')
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

// Picker de priorité : un PATCH par click sur l'une des 4 valeurs.
// Modale ultra simple — pas de search, juste 4 boutons radio-like.
async function tkOpenPriorityPicker(id) {
  const current = (_currentTk?.id === id ? _currentTk.priority : null) || _tickets.find(t => t.id === id)?.priority || 'normal'
  const opts = [
    { v: 'critical', color: '#dc2626' },
    { v: 'high',     color: '#d97706' },
    { v: 'normal',   color: '#0d9488' },
    { v: 'low',      color: '#64748b' },
  ]
  showModal(`
    <div class="modal-title">${t('tickets.priority.picker_title')}</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${opts.map(o => `
        <button class="btn ${o.v === current ? 'btn-primary' : ''}"
          style="justify-content:flex-start;text-align:left;border-left:4px solid ${o.color}"
          onclick="tkSetPriority('${id}', '${o.v}')">
          <span style="font-weight:500">${esc(prioLabel(o.v))}</span>
          ${o.v === current ? `<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">(${t('tickets.priority.current')})</span>` : ''}
        </button>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
}

async function tkSetPriority(id, priority) {
  try {
    await window.api.updateTicket(id, { priority })
    const tk = await window.api.getTicket(id)
    const idx = _tickets.findIndex(t => t.id === id)
    if (idx !== -1) _tickets[idx].priority = priority
    closeModal()
    renderListOrKanban()
    renderDetail(tk)
    showToast(t('tickets.toast.priority_changed'), 'success')
  } catch {
    showToast(t('error.generic'), 'error')
  }
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
                onclick="window.tkPickAssignee(${jsArg(u.entra_id)}, ${jsArg(u.display_name)})">
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
                onclick="window.tkPickRequester(${jsArg(u.entra_id)})">
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

// Relance l'envoi d'un message en échec (dead-letter). Le worker outbound
// le reprend au prochain tick.
async function tkRetrySend(ticketId, msgId) {
  try {
    await window.api.retrySendMessage(ticketId, msgId)
    const tk = await window.api.getTicket(ticketId)
    renderDetail(tk)
    showToast(t('tickets.msg.retry_queued'), 'success')
  } catch { showToast(t('error.generic'), 'error') }
}

// Pièces jointes
async function tkUploadAttachment(ticketId, inputEl) {
  const file = inputEl?.files?.[0]
  if (!file) return
  try {
    await window.api.uploadAttachment(ticketId, file)
    inputEl.value = '' // permet de re-uploader le même fichier ensuite
    await refreshTicket(ticketId)
    showToast(t('tickets.attachments.uploaded'), 'success')
  } catch (err) {
    showToast(err?.status === 413 ? t('tickets.attachments.too_large') : (err?.body?.error || t('error.generic')), 'error')
  }
}

async function tkDownloadAttachment(ticketId, attId, filename) {
  try {
    await window.api.downloadAttachment(ticketId, attId, filename)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkRemoveAttachment(ticketId, attId) {
  if (!confirm(t('tickets.attachments.confirm_remove'))) return
  try {
    await window.api.deleteAttachment(ticketId, attId)
    await refreshTicket(ticketId)
  } catch { showToast(t('error.generic'), 'error') }
}

// Phase 2 — actions M2M depuis la liste des related_users / related_devices
async function tkRemoveUser(ticketId, entraId) {
  if (!confirm(t('tickets.related_users.confirm_remove'))) return
  try {
    await window.api.removeTicketUser(ticketId, entraId)
    await refreshTicket(ticketId)
  } catch { showToast(t('error.generic'), 'error') }
}

async function tkRemoveDevice(ticketId, deviceId) {
  if (!confirm(t('tickets.related_devices.confirm_remove'))) return
  try {
    await window.api.removeTicketDevice(ticketId, deviceId)
    await refreshTicket(ticketId)
  } catch { showToast(t('error.generic'), 'error') }
}

// Fusion : demande l'ID cible (8 premiers chars suffisent — on cherche par
// préfixe pour confort, mais la confirmation montre les 2 titres pour
// éviter une fusion accidentelle).
async function tkOpenMergeModal(sourceId) {
  showModal(`
    <div class="modal-title">${t('tickets.merge.modal_title')}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="font-size:12px;color:var(--text-secondary)">${esc(t('tickets.merge.modal_help'))}</div>
      <input class="form-input" id="tk-merge-q" placeholder="${t('tickets.merge.search')}" autocomplete="off">
      <div id="tk-merge-results" style="max-height:240px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
    </div>`)
  const input = document.getElementById('tk-merge-q')
  const list  = document.getElementById('tk-merge-results')
  setTimeout(() => input?.focus(), 50)

  const renderResults = () => {
    const q = input.value.trim().toLowerCase()
    if (!q) { list.innerHTML = ''; return }
    // On reste sur _tickets en mémoire : pas d'appel API supplémentaire.
    // Filtre par titre ou préfixe d'ID, exclut le source et les déjà-merged.
    const matches = _tickets.filter(t =>
      t.id !== sourceId &&
      t.status !== 'merged' &&
      ((t.title || '').toLowerCase().includes(q) || t.id.startsWith(q))
    ).slice(0, 20)
    list.innerHTML = matches.length
      ? matches.map(t => `
          <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
            onclick="window.tkConfirmMerge('${sourceId}','${t.id}')">
            <div style="font-size:13px">${esc(t.title || '(sans titre)')}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${t.id.slice(0, 8)} · ${statusLabel(t.status)}</div>
          </div>`).join('')
      : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.merge.no_match')}</div>`
  }
  input.addEventListener('input', renderResults)

  window.tkConfirmMerge = async (srcId, tgtId) => {
    const srcTk = _tickets.find(x => x.id === srcId)
    const tgtTk = _tickets.find(x => x.id === tgtId)
    if (!confirm(t('tickets.merge.confirm')
        .replace('{source}', srcTk?.title || srcId)
        .replace('{target}', tgtTk?.title || tgtId))) return
    closeModal()
    try {
      await window.api.mergeTicket(srcId, tgtId)
      showToast(t('tickets.merge.success'), 'success')
      // Recharge la liste pour faire disparaître le ticket merged + redirige
      // sur le target.
      await loadTickets()
      await selectTicket(tgtId)
    } catch (err) {
      const msg = err?.body?.error || t('error.generic')
      showToast(msg, 'error')
    }
  }
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

// Debounce 250 ms : évite un appel API à chaque touche. Le filtre local
// (renderListOrKanban → matche title + hostname) reste appelé immédiatement
// pour que la liste se restreigne visuellement sans flicker pendant la
// frappe ; loadTickets() rafraîchit ensuite avec le résultat backend complet
// (qui matche aussi description, messages, personnes).
let _searchDebounce = null
function filterTickets(q) {
  _localQ = q
  renderListOrKanban()
  if (_searchDebounce) clearTimeout(_searchDebounce)
  _searchDebounce = setTimeout(() => { _searchDebounce = null; loadTickets() }, 250)
}

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
          <button class="btn btn-sm ${_filters.assigned_to==='me'?'btn-primary':''}" onclick="tkSetAssignedFilter('me',${jsArg(t('tickets.filters.assignee_me'))})">${t('tickets.filters.assignee_me')}</button>
          <button class="btn btn-sm ${_filters.assigned_to==='unassigned'?'btn-primary':''}" onclick="tkSetAssignedFilter('unassigned',${jsArg(t('tickets.filters.assignee_unassigned'))})">${t('tickets.filters.assignee_unassigned')}</button>
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
                onclick="window.tkPickAssignedFilter(${jsArg(u.entra_id)}, ${jsArg(u.display_name)})">
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
    <span style="cursor:pointer;opacity:0.7" onclick="tkRemoveChip(${jsArg(key)})">×</span>
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

// ─── Vue « À trier » : mails entrants sans ticket ────────────────────────────
// Les mails d'une même conversation Outlook sont regroupés en un fil : une
// seule décision par fil (créer un ticket / rattacher / ignorer), et le
// ticket créé contient tous les mails du fil.

let _inboxMails    = []      // mails pending_review (API /email/inbox)
let _inboxThreads  = []      // regroupés par conversation
let _inboxActive   = null    // clé du fil sélectionné
let _inboxQ        = ''
let _inboxBodies   = {}      // mappingId → { body_text, source }

function cleanSubjectFront(s) {
  return String(s || '').replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim() || t('tickets.inbox.no_subject')
}

function groupInboxThreads(mails) {
  const map = new Map()
  for (const m of mails) {
    const key = m.conversation_id || m.id
    if (!map.has(key)) map.set(key, { key, mails: [] })
    map.get(key).mails.push(m)
  }
  const threads = [...map.values()].map(th => {
    th.mails.sort((a, b) => Date.parse(a.received_at || 0) - Date.parse(b.received_at || 0))
    th.latest = th.mails[th.mails.length - 1]
    th.first  = th.mails[0]
    th.count  = Math.max(th.mails.length, th.latest.thread_count || 1)
    th.senders = [...new Set(th.mails.map(m => m.from_name || m.from_address).filter(Boolean))]
    return th
  })
  threads.sort((a, b) => Date.parse(b.latest.received_at || 0) - Date.parse(a.latest.received_at || 0))
  return threads
}

function renderInboxLayout(main) {
  main.innerHTML = `
    <div class="inbox-split">
      <div class="inbox-list-col">
        <div class="toolbar" style="padding:8px 10px;gap:6px">
          <div class="search-bar" style="max-width:none;padding:5px 9px">
            <i class="ti ti-search"></i>
            <input id="inbox-q" placeholder="${esc(t('tickets.inbox.search'))}" oninput="inboxFilter(this.value)" value="${esc(_inboxQ)}">
          </div>
          <button class="btn btn-sm" onclick="inboxReload()" title="${esc(t('btn.refresh'))}"><i class="ti ti-refresh"></i></button>
        </div>
        <div class="inbox-list" id="inbox-list">
          <div class="empty-state" style="padding:2rem"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
        </div>
      </div>
      <div class="inbox-detail" id="inbox-detail">
        <div class="ticket-detail-empty">
          <i class="ti ti-mail-opened" style="font-size:32px"></i>
          <span>${esc(t('tickets.inbox.select_hint'))}</span>
        </div>
      </div>
    </div>`
  inboxReload()
}

async function inboxReload() {
  try { _inboxMails = await window.api.getInbox({ limit: 500 }) } catch { _inboxMails = [] }
  _inboxThreads = groupInboxThreads(_inboxMails)
  _inboxCount = _inboxMails.length
  updateInboxBadge()
  updateSubtitle()
  renderInboxList()
  if (_inboxActive && !_inboxThreads.some(th => th.key === _inboxActive)) _inboxActive = null
  if (!_inboxActive && _inboxThreads.length) inboxSelect(_inboxThreads[0].key)
  else if (_inboxActive) inboxSelect(_inboxActive)
  else renderInboxEmptyDetail()
}

function inboxFilter(q) {
  _inboxQ = q
  renderInboxList()
}

function inboxVisibleThreads() {
  const q = _inboxQ.trim().toLowerCase()
  if (!q) return _inboxThreads
  return _inboxThreads.filter(th =>
    (th.latest.subject || '').toLowerCase().includes(q) ||
    th.senders.some(s => s.toLowerCase().includes(q)) ||
    th.mails.some(m => (m.from_address || '').toLowerCase().includes(q) || (m.body_preview || '').toLowerCase().includes(q))
  )
}

function aiChip(m) {
  const cls = m.classifier_result
  if (!cls || cls.fallback) return ''
  const label = cls.intent === 'new_ticket' ? t('tickets.inbox.suggest.new_ticket')
              : cls.intent === 'reply'      ? t('tickets.inbox.suggest.reply')
              : cls.intent === 'other'      ? t('tickets.inbox.suggest.dismiss')
              : cls.intent
  const kind = cls.intent === 'new_ticket' ? 'ai-new' : cls.intent === 'reply' ? 'ai-reply' : 'ai-other'
  const pct = Math.round((cls.confidence || 0) * 100)
  return `<span class="inbox-chip ${kind}" title="${esc((cls.reason || '') + ' (' + pct + '%)')}"><i class="ti ti-sparkles"></i> ${esc(label)}${pct ? ` ${pct}%` : ''}</span>`
}

function renderInboxList() {
  const el = document.getElementById('inbox-list')
  if (!el) return
  const threads = inboxVisibleThreads()
  if (!threads.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem">
      <i class="ti ti-mail-check"></i>
      <p>${esc(_inboxThreads.length ? t('tickets.inbox.no_match') : t('tickets.inbox.empty'))}</p>
      ${!_inboxThreads.length ? `<p style="font-size:11.5px;max-width:260px;text-align:center;line-height:1.4">${esc(t('tickets.inbox.empty_hint'))}</p>` : ''}
    </div>`
    return
  }
  el.innerHTML = threads.map(th => {
    const m = th.latest
    const who = th.senders.length > 1 ? th.senders.map(shortName).join(', ') : (m.from_name || m.from_address || '?')
    return `<div class="inbox-row ${_inboxActive === th.key ? 'active' : ''}" onclick="inboxSelect(${jsArg(th.key)})">
      <div class="inbox-row-top">
        <span class="inbox-row-from">${esc(who)}</span>
        <span class="inbox-row-time">${whenHtml(m.received_at)}</span>
      </div>
      <div class="inbox-row-subj">${esc(cleanSubjectFront(m.subject))}</div>
      ${m.body_preview ? `<div class="inbox-row-prev">${esc(m.body_preview)}</div>` : ''}
      <div class="inbox-row-meta">
        ${th.count > 1 ? `<span class="inbox-chip thread"><i class="ti ti-messages"></i> ${esc(t('tickets.inbox.thread_n', { n: th.count }))}</span>` : ''}
        ${aiChip(m)}
        ${m.suggested_user_name ? `<span class="inbox-chip"><i class="ti ti-user"></i> ${esc(shortName(m.suggested_user_name))}</span>` : `<span class="inbox-chip" title="${esc(t('tickets.inbox.unknown_sender'))}"><i class="ti ti-user-question"></i> ${esc(t('tickets.inbox.external'))}</span>`}
        ${m.suggested_device_hostname ? `<span class="inbox-chip"><i class="ti ti-device-laptop"></i> ${esc(m.suggested_device_hostname)}</span>` : ''}
        ${m.has_attachments ? `<span class="inbox-chip" title="${esc(t('tickets.info.attachments'))}"><i class="ti ti-paperclip"></i></span>` : ''}
      </div>
    </div>`
  }).join('')
}

function renderInboxEmptyDetail() {
  const d = document.getElementById('inbox-detail')
  if (!d) return
  d.innerHTML = `<div class="ticket-detail-empty">
    <i class="ti ti-mail-check" style="font-size:32px"></i>
    <span>${esc(_inboxThreads.length ? t('tickets.inbox.select_hint') : t('tickets.inbox.all_done'))}</span>
  </div>`
}

async function inboxSelect(key) {
  _inboxActive = key
  renderInboxList()
  const th = _inboxThreads.find(x => x.key === key)
  const d = document.getElementById('inbox-detail')
  if (!th || !d) { renderInboxEmptyDetail(); return }
  const m = th.latest

  d.innerHTML = `
    <div class="inbox-detail-header">
      <div class="td-topline">
        <span class="badge badge-blue"><i class="ti ti-mail"></i> ${esc(m.mailbox || '')}</span>
        ${th.count > 1 ? `<span class="badge badge-green"><i class="ti ti-messages"></i> ${esc(t('tickets.inbox.thread_n', { n: th.count }))}</span>` : ''}
        ${aiChip(m)}
        <span>${esc(t('tickets.inbox.last_mail'))} ${whenHtml(m.received_at)}</span>
      </div>
      <div class="inbox-detail-title">${esc(cleanSubjectFront(m.subject))}</div>
      <div class="inbox-detail-actions">
        <button class="btn btn-primary" id="inbox-btn-ticket" onclick="inboxToTicket(${jsArg(m.id)})">
          <i class="ti ti-ticket"></i> ${esc(th.count > 1 ? t('tickets.inbox.to_ticket_n', { n: th.count }) : t('tickets.inbox.to_ticket'))}
        </button>
        <button class="btn" onclick="inboxOpenAttach(${jsArg(m.id)})" title="${esc(t('tickets.inbox.attach_hint'))}">
          <i class="ti ti-arrows-join"></i> ${esc(t('tickets.inbox.attach'))}
        </button>
        <button class="btn btn-ghost" onclick="inboxDismiss(${jsArg(m.id)}, ${th.count > 1 ? 'true' : 'false'})" style="margin-left:auto">
          <i class="ti ti-eye-off"></i> ${esc(th.count > 1 ? t('tickets.inbox.dismiss_thread') : t('tickets.inbox.dismiss'))}
        </button>
      </div>
      <div class="td-props">
        ${m.suggested_user_name
          ? `<span class="td-prop" title="${esc(t('tickets.inbox.will_be_requester'))}"><i class="ti ti-user"></i>${userLink(m.suggested_user_id, m.suggested_user_name)}<span class="lbl">${esc(t('tickets.inbox.will_be_requester'))}</span></span>`
          : `<span class="td-prop empty" title="${esc(t('tickets.inbox.unknown_sender'))}"><i class="ti ti-user-question"></i>${esc(m.from_address || '')} · ${esc(t('tickets.inbox.external'))}</span>`}
        ${m.suggested_device_hostname ? `<span class="td-prop"><i class="ti ti-device-laptop"></i>${deviceLink(m.suggested_device_id, m.suggested_device_hostname)}</span>` : ''}
      </div>
    </div>
    <div class="inbox-detail-body" id="inbox-thread">
      <div style="text-align:center;color:var(--text-tertiary);padding:20px"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  let items
  try { items = await window.api.getInboxThread(m.id) } catch { items = th.mails.map(x => ({ ...x, direction: 'inbound' })) }
  if (_inboxActive !== key) return
  const body = document.getElementById('inbox-thread')
  if (!body) return

  body.innerHTML = `
    ${items.length > 1 ? `<div class="inbox-hint"><i class="ti ti-info-circle"></i><span>${esc(t('tickets.inbox.thread_hint', { n: items.length }))}</span></div>` : ''}
    ${items.map(it => `
      <div class="mail-card ${it.direction === 'outbound' ? 'out' : ''}" id="mail-card-${it.id}">
        <div class="mail-card-head">
          <span class="msg-av ${it.direction === 'outbound' ? '' : 'av-mail'}" style="width:26px;height:26px;font-size:10px">${esc(initialsOf(it.from_name || it.from_address))}</span>
          <span class="who">${esc(it.from_name || it.from_address || '?')}</span>
          ${it.from_name && it.from_address ? `<span class="addr">&lt;${esc(it.from_address)}&gt;</span>` : ''}
          ${it.action === 'skipped_other' ? `<span class="badge badge-gray" title="${esc(t('tickets.inbox.was_dismissed_hint'))}">${esc(t('tickets.inbox.was_dismissed'))}</span>` : ''}
          ${it.has_attachments ? `<span class="badge badge-gray"><i class="ti ti-paperclip"></i></span>` : ''}
          <span class="when" title="${esc(fmtDateFull(it.received_at))}">${esc(fmtDateShort(it.received_at))}</span>
        </div>
        <div class="mail-card-body loading" id="mail-body-${it.id}">${esc(it.body_preview || '')}</div>
      </div>`).join('')}`

  // Corps complets chargés en parallèle (Graph), aperçu conservé en fallback.
  await Promise.all(items.map(async it => {
    try {
      const b = _inboxBodies[it.id] || (_inboxBodies[it.id] = await window.api.getInboxBody(it.id))
      const el = document.getElementById(`mail-body-${it.id}`)
      if (el) {
        el.textContent = b.body_text || it.body_preview || t('tickets.inbox.empty_body')
        el.classList.remove('loading')
        if (b.source === 'preview') el.insertAdjacentHTML('beforeend', `<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);font-style:italic">${esc(t('tickets.inbox.preview_only'))}</div>`)
      }
    } catch {
      document.getElementById(`mail-body-${it.id}`)?.classList.remove('loading')
    }
  }))
}

function inboxToggleRaw() {}

async function inboxToTicket(mappingId) {
  const btn = document.getElementById('inbox-btn-ticket')
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>` }
  try {
    const { ticket, absorbed } = await window.api.inboxToTicket(mappingId)
    showToast(absorbed > 1 ? t('tickets.inbox.ticket_created_n', { n: absorbed }) : t('tickets.inbox.ticket_created'), 'success')
    _inboxActive = null
    await loadInboxCount()
    // Ouvre le ticket créé en vue liste.
    _activeId = ticket?.id || null
    _view = 'list'
    writeView('list')
    document.querySelectorAll('#tk-seg .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0))
    await loadTickets()
    renderMain()
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-ticket"></i> ${esc(t('tickets.inbox.to_ticket'))}` }
    showToast(err?.body?.error || t('error.generic'), 'error')
  }
}

async function inboxDismiss(mappingId, wholeThread) {
  if (!confirm(wholeThread ? t('tickets.inbox.confirm_dismiss_thread') : t('tickets.inbox.confirm_dismiss'))) return
  try {
    await window.api.inboxDismiss(mappingId, wholeThread)
    _inboxActive = null
    await inboxReload()
  } catch (err) {
    showToast(err?.body?.error || t('error.generic'), 'error')
  }
}

// Rattacher à un ticket existant : recherche serveur (titre, description,
// messages, personnes), archives incluses via un second appel.
function inboxOpenAttach(mappingId) {
  showModal(`
    <div class="modal-title">${esc(t('tickets.inbox.attach_title'))}</div>
    <div class="modal-sub">${esc(t('tickets.inbox.attach_help'))}</div>
    <input class="form-input" id="inbox-attach-q" placeholder="${esc(t('tickets.merge.search'))}" autocomplete="off">
    <div class="pick-list" id="inbox-attach-results" style="margin-top:8px"></div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
  const input = document.getElementById('inbox-attach-q')
  const list  = document.getElementById('inbox-attach-results')
  setTimeout(() => input?.focus(), 50)

  const paint = (tickets) => {
    list.innerHTML = tickets.length
      ? tickets.map(tk => `
          <div class="pick-row" onclick="window.inboxConfirmAttach(${jsArg(mappingId)}, '${tk.id}', ${jsArg(tk.title)})">
            <div class="t">${esc(tk.title)}</div>
            <div class="s">#${ticketRef(tk.id)} · ${statusLabel(tk.status)}${tk.requester_name ? ' · ' + esc(tk.requester_name) : ''} · ${displayWhen(tk)}</div>
          </div>`).join('')
      : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('tickets.merge.no_match')}</div>`
  }
  const search = async () => {
    const q = input.value.trim()
    const params = { limit: 30 }
    if (q) params.q = q
    try {
      const [live, archived] = await Promise.all([
        window.api.getTickets(params),
        q ? window.api.getTickets({ ...params, status: 'closed', limit: 10 }).catch(() => []) : Promise.resolve([]),
      ])
      paint([...live, ...archived].filter(tk => tk.status !== 'merged'))
    } catch { list.innerHTML = '' }
  }
  let timer
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250) })
  search()

  window.inboxConfirmAttach = async (mid, ticketId, title) => {
    if (!confirm(t('tickets.inbox.attach_confirm', { title }))) return
    closeModal()
    try {
      const out = await window.api.inboxAttach(mid, ticketId)
      showToast(t('tickets.inbox.attached', { n: out.appended }), 'success')
      _inboxActive = null
      await loadInboxCount()
      _activeId = ticketId
      _view = 'list'
      writeView('list')
      document.querySelectorAll('#tk-seg .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0))
      await loadTickets()
      renderMain()
    } catch (err) {
      showToast(err?.body?.error || t('error.generic'), 'error')
    }
  }
}

// Modale diagnostic du pont mail (issue #8). Affiche :
//   - Conf classifieur (URL, modèle, enabled) + état du polling
//   - Liste des derniers mails ingérés avec leur action + classif
//   - Erreurs récentes (Ollama timeout, etc.)
// Permet à l'admin de comprendre "pourquoi le compteur est bas" sans psql.
async function openMailDiagnosticModal() {
  // Phase 4 — alignée sur la largeur des modales Propositions et Mails à
  // trier : le contenu (config + breakdown + 50 derniers mails) déborde
  // sinon sur le max-width 640px par défaut de showModal.
  showWideModal(`
    <div class="modal-title">${t('tickets.mail_diag.title')}</div>
    <div id="mail-diag-body" style="max-height:72vh;overflow-y:auto;margin-top:10px;font-size:13px">
      <div style="text-align:center;color:var(--text-tertiary);padding:20px">${t('common.loading')}…</div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">${t('btn.close')}</button>
    </div>`)

  // Fetch parallèle : 3 endpoints distincts, indépendants.
  const [stats, recent, diag, status] = await Promise.all([
    window.api.getEmailStats(7).catch(() => null),
    window.api.getEmailRecent({ limit: 50 }).catch(() => []),
    window.api.getEmailDiagnostic().catch(() => null),
    window.api.getEmailStatus().catch(() => null),
  ])

  const body = document.getElementById('mail-diag-body')
  if (!body) return  // modale fermée entretemps

  body.innerHTML = `
    ${renderMailDiagConfig(diag, status)}
    ${renderMailDiagStats(stats)}
    ${renderMailDiagRecent(recent)}
    ${renderMailDiagErrors(diag?.recent_errors || [])}
  `
}

function renderMailDiagConfig(diag, status) {
  if (!diag) return ''
  const c = diag.config || {}
  const cls = c.classifier || {}
  const mailboxes = status?.mailboxes || []
  const sentMailboxes = status?.sent_mailboxes || []

  const dot = (on) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${on?'#0d9488':'#dc2626'};vertical-align:1px;margin-right:6px"></span>`
  // Mail en échec qui retient le curseur (cf. api email-bridge/lib/poll-cursor.js).
  const blockedLine = (b) => b ? `<div style="color:var(--red);font-weight:600">${esc(t('tickets.mail_diag.blocked', {
    since: b.since ? formatRelative(b.since) : '?', attempts: b.attempts,
    id: b.internet_message_id || '?', error: b.error || '?' }))}</div>` : ''

  return `
    <section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">${t('tickets.mail_diag.config')}</div>
      <div style="background:var(--bg-tertiary);border-radius:6px;padding:10px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
        <div>${dot(c.poll_enabled)} ${t('tickets.mail_diag.poll_enabled')}</div>
        <div style="color:var(--text-secondary)">${esc(c.inboxes) || '(aucune)'}</div>
        <div>${dot(c.send_enabled)} ${t('tickets.mail_diag.send_enabled')}</div>
        <div style="color:var(--text-secondary)">${esc(c.sender_address) || '(non configuré)'}</div>
        <div>${dot(c.mark_as_read_enabled)} ${t('tickets.mail_diag.mark_read_enabled')}</div>
        <div style="color:var(--text-secondary)">${c.mark_as_read_enabled ? t('common.yes') : t('common.no')}</div>
        <div>${dot(cls.enabled && cls.url && cls.model)} ${t('tickets.mail_diag.classifier')}</div>
        <div style="color:var(--text-secondary)">${cls.enabled ? `${esc(cls.model || '(?)')} @ ${esc(cls.url || '(?)')}` : t('tickets.mail_diag.classifier_off')}</div>
      </div>
      ${mailboxes.length || sentMailboxes.length ? `
        <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary)">
          ${mailboxes.map(m => `<div>${esc(m.address)} — ${t('tickets.mail_diag.cursor')}: ${m.cursor ? formatRelative(m.cursor) : '(init)'} · ${m.total_ingested} ${t('tickets.mail_diag.ingested')}</div>${blockedLine(m.blocked)}`).join('')}
          ${sentMailboxes.map(m => `<div>${esc(m.address)} — ${t('tickets.mail_diag.sent')} · ${t('tickets.mail_diag.cursor')}: ${m.cursor ? formatRelative(m.cursor) : '(init)'}</div>${blockedLine(m.blocked)}`).join('')}
        </div>` : ''}
    </section>`
}

function renderMailDiagStats(stats) {
  if (!stats) return ''
  const a = stats.by_action || {}
  const items = [
    ['proposal_created',           t('tickets.mail_diag.proposals'),      '#0d9488'],
    ['proposal_created_no_match',  t('tickets.mail_diag.proposals_reply'),'#0d9488'],
    ['message_appended',           t('tickets.mail_diag.appended'),       '#2563eb'],
    ['skipped_other',              t('tickets.mail_diag.skipped_other'),  '#64748b'],
    ['in_queue',                   t('tickets.mail_diag.in_queue'),       '#d97706'],
    ['skipped_error',              t('tickets.mail_diag.errors'),         '#dc2626'],
  ]
  return `
    <section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">${t('tickets.mail_diag.activity', { n: stats.total, days: stats.days })}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${items.filter(([k]) => a[k]).map(([k, label, color]) => `
          <div style="background:${color}20;color:${color};padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500">
            ${a[k]} · ${esc(label)}
          </div>`).join('')}
      </div>
    </section>`
}

function renderMailDiagRecent(rows) {
  if (!rows?.length) {
    return `<section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">${t('tickets.mail_diag.recent_title')}</div>
      <div style="color:var(--text-tertiary);font-size:12px;padding:8px">${t('tickets.mail_diag.recent_empty')}</div>
    </section>`
  }

  const actionLabel = {
    proposal_created:           t('tickets.mail_diag.label_proposal'),
    proposal_created_no_match:  t('tickets.mail_diag.label_proposal_reply'),
    message_appended:           t('tickets.mail_diag.label_appended'),
    skipped_other:              t('tickets.mail_diag.label_other'),
    skipped_error:              t('tickets.mail_diag.label_error'),
  }
  const actionColor = {
    proposal_created:           '#0d9488',
    proposal_created_no_match:  '#0d9488',
    message_appended:           '#2563eb',
    skipped_other:              '#64748b',
    skipped_error:              '#dc2626',
  }

  return `
    <section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">${t('tickets.mail_diag.recent_title')} (${rows.length})</div>
      <div style="background:var(--bg-tertiary);border-radius:6px;overflow:hidden">
        ${rows.map(r => {
          const cls = r.classifier_result || {}
          const isFallback = cls.fallback === true
          const conf = typeof cls.confidence === 'number' ? Math.round(cls.confidence * 100) : null
          const confBadge = isFallback
            ? `<span style="background:var(--bg-secondary);color:var(--text-tertiary);padding:0 5px;border-radius:6px;font-size:10px">— sans classif</span>`
            : (conf != null ? `<span style="background:${conf>=80?'#0d9488':conf>=50?'#d97706':'#dc2626'};color:#fff;padding:0 5px;border-radius:6px;font-size:10px">${conf}%</span>` : '')
          const aColor = actionColor[r.action] || '#64748b'
          return `
            <div style="padding:8px 10px;border-bottom:0.5px solid var(--border);display:flex;gap:8px;align-items:flex-start">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject || '(sans sujet)')}</div>
                <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">
                  ${esc(r.from_address || '?')} · ${formatRelative(r.received_at)}
                </div>
              </div>
              <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
                ${confBadge}
                <span style="background:${aColor}20;color:${aColor};padding:1px 6px;border-radius:6px;font-size:10px;font-weight:500">${esc(actionLabel[r.action] || r.action || '?')}</span>
              </div>
            </div>`
        }).join('')}
      </div>
    </section>`
}

function renderMailDiagErrors(errors) {
  if (!errors.length) return ''
  return `
    <section>
      <div style="font-weight:600;margin-bottom:6px;color:#dc2626">${t('tickets.mail_diag.errors_title')} (${errors.length})</div>
      <div style="background:#dc262610;border-radius:6px;padding:8px;font-size:11px;color:var(--text-secondary)">
        ${errors.map(e => `
          <div style="padding:4px 0;border-bottom:0.5px solid var(--border)">
            <div style="color:var(--text-primary)">${esc(e.subject || '(sans sujet)')}</div>
            <div style="color:var(--text-tertiary)">${esc(e.error_message || e.classifier_result?.reason || '(pas de détail)')}</div>
          </div>`).join('')}
      </div>
    </section>`
}

async function openProposalsModal() {
  let list = []
  try { list = await window.api.getProposals({ status: 'pending' }) } catch { list = [] }

  // Override de la largeur par défaut du #modal-content (max-width:640px)
  // pour la modale propositions : on a souvent ~10 cards à afficher avec
  // description longue, le 640px serre trop. 1100px / 92vw = lisible
  // sur écran moyen, gardable sur petit écran.
  showWideModal(`
    <div class="modal-title">${t('tickets.proposals.title')} (${list.length})</div>
    <div style="max-height:72vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-top:10px">
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

  // Confiance du classifieur (Phase 2 du pont mail, issue #8). Présente
  // uniquement sur les propositions source='email'. Stockée dans
  // source_payload.classifier.{intent, confidence, reason, fallback?}.
  //
  // Trois états possibles dans le badge :
  //   1. fallback=true  → "—" gris : Ollama a échoué/timeout, pas de
  //                       classif fiable (la conf 0 n'est PAS un vrai 0 %)
  //   2. confidence ≥0.8 → vert : auto-acceptable
  //      conf 0.5-0.8    → ambre : à vérifier
  //      conf <0.5       → rouge : probable faux positif
  //   3. pas de classif  → badge absent (proposal manuelle / autre source)
  const cls = p.source_payload?.classifier
  let confBadge = ''
  if (cls?.fallback === true) {
    const title = cls.reason ? `Non classifié (fallback) — ${cls.reason}` : 'Non classifié (fallback)'
    confBadge = `<span style="background:var(--bg-tertiary);color:var(--text-secondary);padding:1px 6px;border-radius:8px;font-weight:500;font-size:11px" title="${esc(title)}">— sans classif</span>`
  } else if (cls && typeof cls.confidence === 'number') {
    const pct = Math.round(cls.confidence * 100)
    const color = pct >= 80 ? '#0d9488' : pct >= 50 ? '#d97706' : '#dc2626'
    const title = cls.reason ? `${cls.intent || ''} — ${cls.reason}` : (cls.intent || '')
    confBadge = `<span style="background:${color};color:#fff;padding:1px 6px;border-radius:8px;font-weight:500" title="${esc(title)}">${pct}%</span>`
  }
  return `
    <div style="border:0.5px solid var(--border);border-radius:6px;padding:12px;background:var(--bg-tertiary)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:var(--text-primary)">${esc(p.suggested_title)}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span style="background:var(--bg-secondary);padding:1px 6px;border-radius:8px"><i class="ti ti-bulb" style="font-size:10px"></i> ${esc(sourceLabel)}</span>
            <span style="color:${prioColor}">● ${prioLabel(p.suggested_priority)}</span>
            ${confBadge}
            <span>${formatRelative(p.created_at)}</span>
          </div>
          ${p.suggested_description ? `<div style="margin-top:8px;font-size:13px;color:var(--text-primary);background:var(--bg-secondary);padding:8px 10px;border-radius:4px;white-space:pre-wrap;max-height:160px;overflow:auto;line-height:1.4">${esc(p.suggested_description)}</div>` : ''}
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
              onclick="window.ntApplyAssignee(${jsArg(u.entra_id)}, ${jsArg(u.display_name)})">
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
              onclick="window.ntApplyRequester(${jsArg(u.entra_id)}, ${jsArg(u.display_name)}, ${jsArg(u.email || '')})">
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

function showWideModal(html) {
  showModal(html)
  document.getElementById('modal-content')?.classList.add('modal-wide')
}

// Valeur inconnue : échappée (status/priority sont du texte libre côté API,
// modifiable par tout utilisateur authentifié sur ses tickets).
function statusLabel(s) {
  return s === 'open'        ? t('tickets.status.open')
       : s === 'in_progress' ? t('tickets.status.in_progress')
       : s === 'resolved'    ? t('tickets.status.resolved')
       : s === 'closed'      ? t('tickets.status.closed')
       : s === 'merged'      ? t('tickets.status.merged')
       : esc(s)
}
function prioLabel(p) {
  return p === 'low'      ? t('prio.low')
       : p === 'normal'   ? t('prio.normal')
       : p === 'high'     ? t('prio.high')
       : p === 'critical' ? t('prio.critical')
       : esc(p)
}
