// Tickets — page liste pleine largeur : dossiers à gauche (À trier, À
// répondre, Les miens, Non assignés, Tous, Résolus, Archives, tags), lignes
// groupées par « ce que ça attend de moi ». Une ligne ouvre la page focus
// (#/tickets/<id>) ; un fil de mails ouvre #/tickets/mail/<id>.

import {
  TAG_PALETTE, TAG_COLOR_KEYS, shortName, initialsOf, ticketRef, tagChip,
  statusLabel, prioLabel, nextLabel, buildQueue, saveQueue,
} from '/views/ticket-shared.js'

const jsArg = window.jsArg

const FOLDERS = ['inbox', 'needs', 'mine', 'unassigned', 'all', 'resolved', 'closed']
let _folder   = 'needs'
let _tagId    = null
let _q        = ''
let _tickets  = []          // tickets chargés (hors archives sauf dossier Archives)
let _inbox    = []          // mails à trier
let _allTags  = []
let _board    = false       // vue tableau (Kanban) — secondaire
let _kbIndex  = -1
let _rows     = []          // lignes affichées (pour j/k)
let _proposalsCount = 0

function readHash() {
  const qs = (window.location.hash || '').split('?')[1] || ''
  const sp = new URLSearchParams(qs)
  const f = sp.get('folder')
  if (FOLDERS.includes(f)) { _folder = f; _tagId = null }
  else if (f === 'tag' && sp.get('tag')) { _folder = 'tag'; _tagId = sp.get('tag') }
  _board = sp.get('view') === 'board'
  return sp
}
function writeHash() {
  const sp = new URLSearchParams()
  if (_folder === 'tag' && _tagId) { sp.set('folder', 'tag'); sp.set('tag', _tagId) }
  else if (_folder !== 'needs') sp.set('folder', _folder)
  if (_board) sp.set('view', 'board')
  const qs = sp.toString()
  const h = qs ? `#/tickets?${qs}` : '#/tickets'
  if (window.location.hash !== h) history.replaceState(null, '', h)
}

export async function renderTickets(container) {
  const sp = readHash()
  const wantNew = sp.get('new') === 'true'
  const prefillDeviceId = sp.get('device')

  container.innerHTML = `
    <div class="page">
      <div class="page-inner wide">
        <div class="page-head">
          <div>
            <h1 class="page-h1" style="font-size:24px">${esc(t('tickets.title'))} <span class="muted" id="tk-count"></span></h1>
          </div>
          <div class="page-actions">
            <div class="search-bar" style="max-width:340px;min-width:260px;padding:6px 10px;background:var(--bg-primary)">
              <i class="ti ti-search"></i>
              <input id="tk-q" placeholder="${esc(t('tickets.search'))}" oninput="tkSearch(this.value)" value="${esc(_q)}">
            </div>
            <div class="seg" title="${esc(t('tickets.view.list'))} / ${esc(t('tickets.view.kanban'))}">
              <button class="seg-btn ${!_board ? 'active' : ''}" onclick="tkSetBoard(false)"><i class="ti ti-list"></i></button>
              <button class="seg-btn ${_board ? 'active' : ''}" onclick="tkSetBoard(true)"><i class="ti ti-layout-kanban"></i></button>
            </div>
            <button class="btn" id="tk-proposals-btn" style="display:none" onclick="openProposalsModal()"><i class="ti ti-bulb"></i> ${esc(t('tickets.proposals.title'))} <span class="seg-count hot" id="tk-proposals-count"></span></button>
            <button class="btn btn-ghost btn-sm" onclick="openMailDiagnosticModal()" title="${esc(t('tickets.mail_diag.title'))}"><i class="ti ti-activity"></i></button>
            <button class="btn btn-ghost btn-sm" onclick="openTagsModal()" title="${esc(t('tickets.tags.manage'))}"><i class="ti ti-tags"></i></button>
          </div>
        </div>
        <div class="tk-page">
          <nav class="folders" id="tk-folders" aria-label="${esc(t('tickets.folders'))}"></nav>
          <div style="min-width:0;display:flex;flex-direction:column;gap:8px">
            <div id="tk-main"><div class="tk-list"><div class="tk-empty"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div></div></div>
            <div class="kbd-hints" id="tk-hints"><span><kbd>j</kbd> <kbd>k</kbd> ${esc(t('tickets.keys.move'))}</span><span><kbd>↵</kbd> ${esc(t('tickets.keys.open'))}</span><span><kbd>n</kbd> ${esc(t('tickets.keys.new'))}</span></div>
          </div>
        </div>
      </div>
    </div>`

  window.tkSearch      = tkSearch
  window.tkSetFolder   = tkSetFolder
  window.tkSetBoard    = tkSetBoard
  window.tkOpen        = tkOpen
  window.openTagsModal = openTagsModal
  window.openProposalsModal = openProposalsModal
  window.openMailDiagnosticModal = openMailDiagnosticModal
  window.tkAcceptProposal = tkAcceptProposal
  window.tkRejectProposal = tkRejectProposal
  window.openQuickTicket = openQuickTicket
  window.tkKanbanDragStart = tkKanbanDragStart
  window.tkKanbanDragOver  = tkKanbanDragOver
  window.tkKanbanDragLeave = tkKanbanDragLeave
  window.tkKanbanDrop      = tkKanbanDrop
  ensureBoardStyles()

  if (!window._tkListKeys) {
    window._tkListKeys = true
    document.addEventListener('keydown', listKeys)
  }

  await Promise.all([loadTags(), loadAll(), loadProposalsCount()])
  render()

  if (wantNew) {
    history.replaceState(null, '', '#/tickets')
    let prefillDevice = null
    if (prefillDeviceId) {
      try { const dev = await window.api.getDevice(prefillDeviceId); if (dev?.id) prefillDevice = { id: dev.id, hostname: dev.hostname } } catch {}
    }
    openQuickTicket({ prefillDevice })
  }
}

async function loadTags() { try { _allTags = await window.api.getTags() } catch { _allTags = [] } }
async function loadProposalsCount() {
  try { _proposalsCount = (await window.api.getProposalsCount()).pending || 0 } catch { _proposalsCount = 0 }
  const b = document.getElementById('tk-proposals-btn'); const c = document.getElementById('tk-proposals-count')
  if (b) b.style.display = _proposalsCount ? '' : 'none'
  if (c) c.textContent = _proposalsCount
}
async function loadAll() {
  const params = { limit: 200 }
  if (_q.trim()) params.q = _q.trim()
  if (_folder === 'closed') params.status = 'closed'
  const [tickets, inbox] = await Promise.all([
    window.api.getTickets(params).catch(() => []),
    window.api.getInbox({ limit: 200 }).catch(() => []),
  ])
  _tickets = tickets
  _inbox = inbox
}

// ── Dossiers ────────────────────────────────────────────────────────────────

function counts() {
  const me = window.appState?.user?.entraId
  const live = _tickets.filter(tk => ['open', 'in_progress'].includes(tk.status))
  return {
    inbox: groupInbox(_inbox).length,
    needs: live.filter(tk => tk.awaiting_reply).length,
    mine: live.filter(tk => tk.assigned_to_entra_id === me).length,
    unassigned: live.filter(tk => !tk.assigned_to_entra_id).length,
    all: live.length,
    resolved: _tickets.filter(tk => tk.status === 'resolved').length,
  }
}

function renderFolders() {
  const el = document.getElementById('tk-folders')
  if (!el) return
  const c = counts()
  const f = (key, icon, label, cnt, cntCls = '') => `
    <button class="folder ${_folder === key ? 'active' : ''}" onclick="tkSetFolder('${key}')">
      <i class="ti ${icon}"></i>${esc(label)}${cnt != null ? `<span class="cnt ${cntCls}">${cnt}</span>` : ''}
    </button>`
  el.innerHTML = `
    ${f('inbox', 'ti-mail-opened', t('tickets.folder.inbox'), c.inbox, c.inbox ? 'hot' : '')}
    ${f('needs', 'ti-corner-down-right', t('tickets.folder.needs'), c.needs, c.needs ? 'needs' : '')}
    ${f('mine', 'ti-user', t('tickets.folder.mine'), c.mine)}
    ${f('unassigned', 'ti-user-off', t('tickets.folder.unassigned'), c.unassigned)}
    ${f('all', 'ti-list', t('tickets.folder.all'), c.all)}
    ${f('resolved', 'ti-check', t('tickets.folder.resolved'), c.resolved)}
    ${f('closed', 'ti-archive', t('tickets.folder.closed'), null)}
    ${_allTags.length ? `<div class="folder-sec">${esc(t('tickets.info.tags'))}</div>` + _allTags.map(g => `
      <button class="folder ${_folder === 'tag' && _tagId === g.id ? 'active' : ''}" onclick="tkSetFolder('tag', '${g.id}')">
        <span class="tagdot" style="background:${(TAG_PALETTE[g.color] || TAG_PALETTE.slate).bg}"></span>${esc(g.name)}
      </button>`).join('') : ''}`
}

async function tkSetFolder(key, tagId = null) {
  const wasClosed = _folder === 'closed'
  _folder = key; _tagId = tagId
  writeHash()
  if (key === 'closed' || wasClosed) await loadAll()
  render()
}
function tkSetBoard(on) { _board = !!on; writeHash(); render() }

let _searchTimer = null
function tkSearch(q) {
  _q = q
  renderMain()
  clearTimeout(_searchTimer)
  _searchTimer = setTimeout(async () => { await loadAll(); render() }, 250)
}

function render() { renderFolders(); renderMain() }

// ── Sélection des lignes ────────────────────────────────────────────────────

function visibleTickets() {
  const me = window.appState?.user?.entraId
  const live = _tickets.filter(tk => ['open', 'in_progress'].includes(tk.status))
  let list
  switch (_folder) {
    case 'needs':      list = live.filter(tk => tk.awaiting_reply); break
    case 'mine':       list = live.filter(tk => tk.assigned_to_entra_id === me); break
    case 'unassigned': list = live.filter(tk => !tk.assigned_to_entra_id); break
    case 'resolved':   list = _tickets.filter(tk => tk.status === 'resolved'); break
    case 'closed':     list = _tickets.filter(tk => tk.status === 'closed'); break
    case 'tag':        list = _tickets.filter(tk => (tk.tags || []).some(g => g.id === _tagId)); break
    default:           list = live
  }
  const q = _q.trim().toLowerCase()
  if (q) {
    const m = list.filter(tk => tk.title.toLowerCase().includes(q) || (tk.hostname || '').toLowerCase().includes(q)
      || (tk.requester_name || '').toLowerCase().includes(q) || ticketRef(tk.id).toLowerCase() === q.replace(/^#/, ''))
    if (m.length || !list.length) list = m
  }
  return list
}

// Groupes : « à répondre » (qui attend depuis le plus longtemps d'abord),
// puis critiques, puis le reste par activité récente.
function groupTickets(list) {
  const waited = tk => Date.parse(tk.updated_at || tk.created_at)
  const needs = list.filter(tk => tk.awaiting_reply && ['open', 'in_progress'].includes(tk.status)).sort((a, b) => waited(a) - waited(b))
  const crit  = list.filter(tk => !needs.includes(tk) && tk.priority === 'critical' && ['open', 'in_progress'].includes(tk.status))
  const rest  = list.filter(tk => !needs.includes(tk) && !crit.includes(tk)).sort((a, b) => waited(b) - waited(a))
  const groups = []
  if (needs.length) groups.push({ key: 'needs', label: t('tickets.group.needs'), list: needs })
  if (crit.length)  groups.push({ key: 'crit',  label: t('tickets.group.critical'), list: crit })
  if (rest.length)  groups.push({ key: 'rest',  label: _folder === 'resolved' ? t('tickets.group.resolved') : _folder === 'closed' ? t('tickets.group.closed') : t('tickets.group.rest'), list: rest })
  return groups
}

function renderMain() {
  const main = document.getElementById('tk-main')
  const hints = document.getElementById('tk-hints')
  if (!main) return
  if (_folder === 'inbox') { renderInbox(main); if (hints) hints.style.display = 'none'; return }
  if (hints) hints.style.display = ''
  const list = visibleTickets()
  const cnt = document.getElementById('tk-count')
  if (cnt) cnt.textContent = list.length ? `· ${list.length}` : ''
  if (_board) { renderBoard(main, list); return }

  const groups = groupTickets(list)
  _rows = groups.flatMap(g => g.list)
  _kbIndex = -1
  if (!list.length) {
    main.innerHTML = `<div class="tk-list"><div class="tk-empty">${esc(emptyLabel())}</div></div>`
    return
  }
  main.innerHTML = `<div class="tk-list">
    <div class="tk-list-head"><span></span><span>${esc(t('tickets.col.ticket'))}</span><span class="col-req">${esc(t('tickets.col.requester'))}</span><span>${esc(t('tickets.col.assignee'))}</span><span class="col-act">${esc(t('tickets.col.activity'))}</span><span>${esc(t('tickets.col.age'))}</span></div>
    ${groups.map(g => `
      <div class="tk-group ${g.key}"><span class="dot"></span>${esc(g.label)} <span class="n">${g.list.length}</span></div>
      ${g.list.map(tk => rowHtml(tk, g.key)).join('')}
    `).join('')}
  </div>`
}

function emptyLabel() {
  if (_q.trim()) return t('tickets.inbox.no_match')
  return t('tickets.folder_empty.' + (_folder === 'tag' ? 'tag' : _folder))
}

function rowHtml(tk, gkey) {
  const nx = nextLabel(tk)
  const cls = gkey === 'needs' ? 'needs' : gkey === 'crit' ? 'crit' : (['resolved', 'closed'].includes(tk.status) ? 'done' : '')
  const tags = (tk.tags || []).slice(0, 3).map(g => tagChip(g, { compact: true })).join('')
  const activity = tk.awaiting_reply
    ? t('tickets.activity.replied', { who: shortName(tk.requester_name) || t('today.someone') })
    : (tk.updated_at && tk.updated_at !== tk.created_at ? t('tickets.activity.updated') : t('tickets.activity.opened'))
  return `<a class="tk-row ${cls}" href="#/tickets/${tk.id}" data-id="${tk.id}" onclick="tkOpen('${tk.id}')">
    <span class="st" title="${esc(nx.label)}"></span>
    <span style="min-width:0">
      <div class="ttl">${esc(tk.title)}</div>
      <div class="sub"><span class="ref">#${ticketRef(tk.id)}</span>${tk.hostname ? `<span>${esc(tk.hostname)}</span>` : ''}${tk.has_inbound_mail || tk.source === 'email' ? `<span><i class="ti ti-mail" style="font-size:11px"></i> ${esc(t('tickets.source.email'))}</span>` : (tk.is_auto ? `<span><i class="ti ti-robot" style="font-size:11px"></i> ${esc(t('tickets.source.auto'))}</span>` : '')}${tk.priority === 'high' || tk.priority === 'critical' ? `<span class="prio-${tk.priority}-c">${esc(prioLabel(tk.priority))}</span>` : ''}${tags}</div>
    </span>
    <span class="who req">${tk.requester_name ? `<span class="mini-av req">${esc(initialsOf(tk.requester_name))}</span>${esc(shortName(tk.requester_name))}` : `<span class="dim">—</span>`}</span>
    <span class="who">${tk.assigned_to_name ? `<span class="mini-av">${esc(initialsOf(tk.assigned_to_name))}</span>${tk.assigned_to_entra_id === window.appState?.user?.entraId ? esc(t('today.why.you')) : esc(shortName(tk.assigned_to_name))}` : `<span class="dim it">${esc(t('tickets.unassigned'))}</span>`}</span>
    <span class="col-act" style="font-size:12.5px;color:var(--text-secondary)">${esc(activity)} · ${formatRelative(tk.updated_at || tk.created_at)}</span>
    <span class="dim">${esc(ageShort(tk.created_at))}</span>
  </a>`
}

function ageShort(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d} j` : `${Math.floor(d / 30)} mo`
}

// Ouvrir depuis la liste : la file « Terminé & suivant » = les lignes affichées.
function tkOpen(id) {
  saveQueue(buildQueue(_rows), _folder)
}

function listKeys(e) {
  if (!document.getElementById('tk-main') || _board || _folder === 'inbox') return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = (e.target?.tagName || '').toLowerCase()
  if (['input', 'textarea', 'select'].includes(tag)) return
  if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) return
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault()
    if (!_rows.length) return
    _kbIndex = e.key === 'j' ? Math.min(_rows.length - 1, _kbIndex + 1) : Math.max(0, _kbIndex - 1)
    document.querySelectorAll('.tk-row.kb-focus').forEach(r => r.classList.remove('kb-focus'))
    const row = document.querySelector(`.tk-row[data-id="${_rows[_kbIndex].id}"]`)
    if (row) { row.classList.add('kb-focus'); row.scrollIntoView({ block: 'nearest' }) }
  } else if (e.key === 'Enter' && _kbIndex >= 0 && _rows[_kbIndex]) {
    e.preventDefault()
    tkOpen(_rows[_kbIndex].id)
    navigateTo(`/tickets/${_rows[_kbIndex].id}`)
  }
}

// ── Dossier « À trier » : fils de mails ─────────────────────────────────────

function groupInbox(mails) {
  const map = new Map()
  for (const m of mails) {
    const key = m.conversation_id || m.id
    if (!map.has(key)) map.set(key, { key, mails: [] })
    map.get(key).mails.push(m)
  }
  return [...map.values()].map(th => {
    th.mails.sort((a, b) => Date.parse(a.received_at || 0) - Date.parse(b.received_at || 0))
    th.latest = th.mails[th.mails.length - 1]
    th.count  = Math.max(th.mails.length, th.latest.thread_count || 1)
    th.senders = [...new Set(th.mails.map(m => m.from_name || m.from_address).filter(Boolean))]
    return th
  }).sort((a, b) => Date.parse(a.latest.received_at || 0) - Date.parse(b.latest.received_at || 0)) // le plus ancien d'abord : on traite dans l'ordre
}
function cleanSubject(s) {
  return String(s || '').replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim() || t('tickets.inbox.no_subject')
}

function renderInbox(main) {
  const q = _q.trim().toLowerCase()
  const threads = groupInbox(_inbox).filter(th => !q || cleanSubject(th.latest.subject).toLowerCase().includes(q) || th.senders.some(s => s.toLowerCase().includes(q)))
  const cnt = document.getElementById('tk-count')
  if (cnt) cnt.textContent = threads.length ? `· ${threads.length}` : ''
  if (!threads.length) {
    main.innerHTML = `<div class="tk-list"><div class="tk-empty">${esc(_inbox.length ? t('tickets.inbox.no_match') : t('tickets.inbox.all_done'))}<div style="font-size:12px;margin-top:6px">${esc(t('tickets.inbox.empty_hint'))}</div></div></div>`
    return
  }
  main.innerHTML = `<div class="tk-list">
    <div class="tk-list-tools" style="font-size:12.5px;color:var(--text-secondary)"><i class="ti ti-info-circle" style="color:var(--primary)"></i> ${esc(t('tickets.inbox.list_hint'))}</div>
    ${threads.map(th => {
      const m = th.latest
      const cls = m.classifier_result?.intent === 'other' ? 'quiet' : 'needs'
      return `<a class="tk-row ${cls}" href="#/tickets/mail/${m.id}">
        <span class="st"></span>
        <span style="min-width:0">
          <div class="ttl">${esc(cleanSubject(m.subject))}</div>
          <div class="sub">${th.count > 1 ? `<span><i class="ti ti-messages" style="font-size:11px"></i> ${esc(t('tickets.inbox.thread_n', { n: th.count }))}</span>` : ''}${m.body_preview ? `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc(m.body_preview)}</span>` : ''}</div>
        </span>
        <span class="who req">${m.suggested_user_name ? `<span class="mini-av req">${esc(initialsOf(m.suggested_user_name))}</span>${esc(shortName(m.suggested_user_name))}` : `<span class="dim" title="${esc(m.from_address || '')}">${esc(m.from_name || m.from_address || '?')}</span>`}</span>
        <span class="who"><span class="dim">${esc(m.suggested_device_hostname || '')}</span></span>
        <span class="col-act" style="font-size:12.5px;color:var(--text-secondary)">${m.classifier_result && !m.classifier_result.fallback ? `<i class="ti ti-sparkles" style="font-size:11px"></i> ${esc(aiLabel(m.classifier_result))}` : ''}</span>
        <span class="dim">${esc(ageShort(m.received_at))}</span>
      </a>`
    }).join('')}
  </div>`
}
function aiLabel(cls) {
  return cls.intent === 'new_ticket' ? t('tickets.inbox.suggest.new_ticket') : cls.intent === 'reply' ? t('tickets.inbox.suggest.reply') : cls.intent === 'other' ? t('tickets.inbox.suggest.dismiss') : cls.intent
}

// ── Vue tableau (secondaire) ────────────────────────────────────────────────

const KANBAN_COLS = ['open', 'in_progress', 'resolved']
function renderBoard(main, list) {
  const groups = { open: [], in_progress: [], resolved: [] }
  for (const tk of list) if (groups[tk.status]) groups[tk.status].push(tk)
  _rows = list
  main.innerHTML = `<div class="kanban-board" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;min-height:420px">
    ${KANBAN_COLS.map(s => `
      <div class="kanban-col" data-status="${s}" ondragover="tkKanbanDragOver(event)" ondragleave="tkKanbanDragLeave(event)" ondrop="tkKanbanDrop(event,'${s}')">
        <div class="kanban-col-header"><span>${esc(statusLabel(s))}</span><span class="kanban-col-count">${groups[s].length}</span></div>
        <div class="kanban-col-body">${groups[s].length ? groups[s].map(tk => boardCard(tk)).join('') : `<div class="kanban-empty">${esc(t('tickets.kanban.empty'))}</div>`}</div>
      </div>`).join('')}
  </div>`
}
function boardCard(tk) {
  const nx = nextLabel(tk)
  return `<a class="kanban-card" draggable="true" href="#/tickets/${tk.id}" ondragstart="tkKanbanDragStart(event,'${tk.id}')" onclick="tkOpen('${tk.id}')" style="text-decoration:none;color:inherit">
    <div class="kc-prio" style="background:${tk.priority === 'critical' ? 'var(--red)' : tk.priority === 'high' ? 'var(--amber)' : 'var(--border-md)'}"></div>
    <div class="kc-body">
      <div class="kc-title">${esc(tk.title)}</div>
      <div class="kc-meta">${nx.cls === 'needs' ? `<span class="kc-badge" style="color:var(--needs)">${esc(nx.label)}</span>` : ''}${tk.requester_name ? `<span class="kc-badge"><i class="ti ti-user" style="font-size:10px"></i> ${esc(shortName(tk.requester_name))}</span>` : ''}${tk.assigned_to_name ? `<span class="kc-badge"><i class="ti ti-user-check" style="font-size:10px"></i> ${esc(shortName(tk.assigned_to_name))}</span>` : ''}</div>
      <div class="kc-time">${formatRelative(tk.updated_at || tk.created_at)}</div>
    </div>
  </a>`
}
function tkKanbanDragStart(e, id) { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move' }
function tkKanbanDragOver(e) { e.preventDefault(); e.currentTarget?.classList.add('kanban-col-hover') }
function tkKanbanDragLeave(e) { e.currentTarget?.classList.remove('kanban-col-hover') }
async function tkKanbanDrop(e, status) {
  e.preventDefault(); e.currentTarget?.classList.remove('kanban-col-hover')
  const id = e.dataTransfer.getData('text/plain')
  const tk = _tickets.find(x => x.id === id)
  if (!tk || tk.status === status) return
  const old = tk.status; tk.status = status; renderMain()
  try { Object.assign(tk, await window.api.updateTicket(id, { status }), { tags: tk.tags }) }
  catch { tk.status = old; renderMain(); showToast(t('error.generic'), 'error') }
}
function ensureBoardStyles() {
  if (document.getElementById('kanban-styles')) return
  const s = document.createElement('style'); s.id = 'kanban-styles'
  s.textContent = `
    .kanban-col { display:flex; flex-direction:column; background:var(--bg-secondary); border:0.5px solid var(--border); border-radius:12px; min-height:0; overflow:hidden; }
    .kanban-col-hover { background:var(--bg-tertiary); outline:2px dashed var(--primary); outline-offset:-4px; }
    .kanban-col-header { padding:8px 12px; border-bottom:0.5px solid var(--border); display:flex; justify-content:space-between; align-items:center; font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-secondary); background:var(--bg-primary); }
    .kanban-col-count { background:var(--bg-tertiary); color:var(--text-secondary); padding:1px 8px; border-radius:10px; font-size:11px; font-weight:500; }
    .kanban-col-body { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
    .kanban-empty { color:var(--text-tertiary); font-size:12px; text-align:center; padding:20px 8px; }
    .kanban-card { background:var(--bg-primary); border:0.5px solid var(--border); border-radius:10px; cursor:pointer; display:flex; overflow:hidden; flex-shrink:0; }
    .kanban-card:hover { border-color: var(--primary); }
    .kc-prio { width:3px; flex-shrink:0; }
    .kc-body { flex:1; padding:8px 10px; display:flex; flex-direction:column; gap:4px; min-width:0; }
    .kc-title { font-size:13px; font-weight:600; line-height:1.3; word-wrap:break-word; }
    .kc-meta { display:flex; gap:4px; flex-wrap:wrap; }
    .kc-badge { display:inline-flex; align-items:center; gap:3px; background:var(--bg-secondary); color:var(--text-secondary); font-size:10px; padding:1px 6px; border-radius:8px; white-space:nowrap; }
    .kc-time { font-size:10px; color:var(--text-tertiary); }`
  document.head.appendChild(s)
}

// ── Capture rapide d'un ticket : titre, puis le reste si on veut ───────────

export function openQuickTicket({ prefillDevice = null } = {}) {
  let pickedDevice = prefillDevice
  let pickedRequester = null
  showModal(`
    <div class="modal-title">${esc(t('tickets.new.title'))}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <input class="form-input" id="qt-title" placeholder="${esc(t('tickets.new.placeholder_title'))}" autocomplete="off" style="font-size:15px;padding:12px" onkeydown="if(event.key==='Enter'){event.preventDefault();window.qtSubmit()}">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px">
        <select class="form-select" id="qt-prio" style="width:auto"><option value="low">${t('prio.low')}</option><option value="normal" selected>${t('prio.normal')}</option><option value="high">${t('prio.high')}</option><option value="critical">${t('prio.critical')}</option></select>
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="qt-me" checked> ${esc(t('tickets.assign_self'))}</label>
        <span id="qt-req" style="color:var(--text-tertiary)"></span>
        <span id="qt-dev" style="color:var(--text-tertiary)"></span>
      </div>
      <details id="qt-more"><summary style="cursor:pointer;font-size:12.5px;color:var(--text-secondary)">${esc(t('tickets.new.more'))}</summary>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          <input class="form-input" id="qt-rq" placeholder="${esc(t('tickets.requester.search'))}" autocomplete="off">
          <div id="qt-rr" class="pick-list" style="display:none"></div>
          <input class="form-input" id="qt-dq" placeholder="${esc(t('tickets.device.search'))}" autocomplete="off">
          <div id="qt-dr" class="pick-list" style="display:none"></div>
          <textarea class="form-textarea" id="qt-desc" placeholder="${esc(t('tickets.new.placeholder_desc'))}"></textarea>
        </div>
      </details>
    </div>
    <div class="modal-footer">
      <span style="font-size:12px;color:var(--text-tertiary);margin-right:auto">↵ ${esc(t('btn.create'))}</span>
      <button class="btn" onclick="closeModal()">${t('btn.cancel')}</button>
      <button class="btn btn-primary" onclick="window.qtSubmit()">${t('btn.create')}</button>
    </div>`)
  setTimeout(() => document.getElementById('qt-title')?.focus(), 30)
  const paint = () => {
    const r = document.getElementById('qt-req'); const d = document.getElementById('qt-dev')
    if (r) r.innerHTML = pickedRequester ? `<i class="ti ti-user"></i> ${esc(pickedRequester.display_name)}` : ''
    if (d) d.innerHTML = pickedDevice ? `<i class="ti ti-device-laptop"></i> ${esc(pickedDevice.hostname)}` : ''
  }
  paint()
  let rt; document.getElementById('qt-rq')?.addEventListener('input', (e) => {
    clearTimeout(rt); const q = e.target.value.trim(); const lst = document.getElementById('qt-rr')
    if (q.length < 2) { lst.style.display = 'none'; return }
    rt = setTimeout(async () => {
      const users = await window.api.searchUsers(q).catch(() => [])
      lst.style.display = ''; lst.innerHTML = users.map(u => `<div class="pick-row" onclick="window.qtPickReq(${jsArg(u.entra_id)},${jsArg(u.display_name)})"><div class="t">${esc(u.display_name)}</div><div class="s">${esc(u.email || '')}</div></div>`).join('') || `<div class="pick-row"><div class="s">${t('tickets.assignee.no_match')}</div></div>`
    }, 200)
  })
  window.qtPickReq = async (id, name) => { pickedRequester = { entra_id: id, display_name: name }; document.getElementById('qt-rr').style.display = 'none'; document.getElementById('qt-rq').value = name; paint()
    if (!pickedDevice) { try { const u = await window.api.getUser(id); if (u?.device?.id) { pickedDevice = { id: u.device.id, hostname: u.device.hostname }; paint() } } catch {} } }
  let devs = null, dt
  document.getElementById('qt-dq')?.addEventListener('input', (e) => {
    clearTimeout(dt); const q = e.target.value.trim().toLowerCase(); const lst = document.getElementById('qt-dr')
    dt = setTimeout(async () => {
      if (!devs) { try { devs = (await window.api.getDevices({ limit: 200 }))?.devices || [] } catch { devs = [] } }
      const f = devs.filter(d => !q || (d.hostname || '').toLowerCase().includes(q) || (d.user_name || '').toLowerCase().includes(q)).slice(0, 30)
      lst.style.display = ''; lst.innerHTML = f.map(d => `<div class="pick-row" onclick="window.qtPickDev('${d.id}',${jsArg(d.hostname || '?')})"><div class="t">${esc(d.hostname || '?')}</div><div class="s">${esc(d.user_name || '')}</div></div>`).join('') || `<div class="pick-row"><div class="s">${t('tickets.assignee.no_match')}</div></div>`
    }, 150)
  })
  window.qtPickDev = (id, hostname) => { pickedDevice = { id, hostname }; document.getElementById('qt-dr').style.display = 'none'; document.getElementById('qt-dq').value = hostname; paint() }
  window.qtSubmit = async () => {
    const title = document.getElementById('qt-title')?.value?.trim()
    if (!title) { showToast(t('tickets.new.title_required'), 'error'); document.getElementById('qt-title')?.focus(); return }
    const me = window.appState?.user
    const assignMe = document.getElementById('qt-me')?.checked && me?.entraId
    try {
      const tk = await window.api.createTicket({
        title, priority: document.getElementById('qt-prio')?.value || 'normal',
        description: document.getElementById('qt-desc')?.value?.trim() || null,
        assigned_to_entra_id: assignMe ? me.entraId : null, assigned_to_name: assignMe ? me.displayName : null,
        user_id: pickedRequester?.entra_id || null, device_id: pickedDevice?.id || null, tag_ids: [],
      })
      closeModal()
      showToast(t('tickets.toast.created'), 'success')
      navigateTo(`/tickets/${tk.id}`)
    } catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
  }
}

// ── Propositions (alertes / scripts) ────────────────────────────────────────

async function openProposalsModal() {
  let list = []
  try { list = await window.api.getProposals({ status: 'pending' }) } catch { list = [] }
  showModal(`
    <div class="modal-title">${t('tickets.proposals.title')} (${list.length})</div>
    <div style="max-height:72vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-top:10px">
      ${list.length ? list.map(p => proposalCard(p)).join('') : `<div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:13px">${t('tickets.proposals.empty')}</div>`}
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.close')}</button></div>`)
  document.getElementById('modal-content')?.classList.add('modal-wide')
}
function proposalCard(p) {
  const sourceMap = { alert: t('tickets.proposals.source.alert'), script: t('tickets.proposals.source.script'), email: t('tickets.proposals.source.email'), manual: t('tickets.proposals.source.manual') }
  return `
    <div style="border:0.5px solid var(--border);border-radius:10px;padding:12px;background:var(--bg-secondary)">
      <div style="font-weight:600;font-size:14px">${esc(p.suggested_title)}</div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
        <span class="badge badge-gray"><i class="ti ti-bulb"></i> ${esc(sourceMap[p.source] || p.source)}</span>
        <span>${esc(prioLabel(p.suggested_priority))}</span>
        <span>${formatRelative(p.created_at)}</span>
        ${p.device_hostname ? `<span><i class="ti ti-device-laptop" style="font-size:10px"></i> ${esc(p.device_hostname)}</span>` : ''}
        ${p.user_display_name ? `<span><i class="ti ti-user" style="font-size:10px"></i> ${esc(p.user_display_name)}</span>` : ''}
      </div>
      ${p.suggested_description ? `<div style="margin-top:8px;font-size:13px;background:var(--bg-primary);padding:8px 10px;border-radius:6px;white-space:pre-wrap;max-height:160px;overflow:auto;line-height:1.4">${esc(p.suggested_description)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
        <button class="btn btn-sm" onclick="window.tkRejectProposal('${p.id}')">${t('tickets.proposals.reject')}</button>
        <button class="btn btn-primary btn-sm" onclick="window.tkAcceptProposal('${p.id}')">${t('tickets.proposals.accept')}</button>
      </div>
    </div>`
}
async function tkAcceptProposal(id) {
  try {
    await window.api.acceptProposal(id, {})
    showToast(t('tickets.proposals.toast.accepted'), 'success')
    await Promise.all([loadProposalsCount(), loadAll()]); render()
    if (_proposalsCount > 0) openProposalsModal(); else closeModal()
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}
async function tkRejectProposal(id) {
  const reason = prompt(t('tickets.proposals.reject_reason_prompt'))
  if (reason === null) return
  try {
    await window.api.rejectProposal(id, reason || null)
    showToast(t('tickets.proposals.toast.rejected'), 'info')
    await loadProposalsCount()
    if (_proposalsCount > 0) openProposalsModal(); else closeModal()
  } catch (err) { showToast(err.message || t('error.generic'), 'error') }
}

// ── Tags ────────────────────────────────────────────────────────────────────

async function openTagsModal() {
  await loadTags()
  showModal(tagsModalContent())
  window.tkCreateTag = async () => {
    const name  = document.getElementById('tg-name')?.value?.trim()
    const color = document.getElementById('tg-color')?.value || 'slate'
    if (!name) { showToast(t('tickets.tags.name_required'), 'error'); return }
    try {
      const tag = await window.api.createTag({ name, color })
      _allTags.push(tag); _allTags.sort((a, b) => a.name.localeCompare(b.name))
      const root = document.getElementById('modal-content'); if (root) root.innerHTML = tagsModalContent()
      renderFolders(); showToast(t('tickets.tags.toast.created'), 'success')
    } catch (err) { showToast(err.message || t('error.generic'), 'error') }
  }
  window.tkDeleteTag = async (id, name) => {
    if (!confirm(t('tickets.tags.confirm_delete').replace('{name}', name))) return
    try {
      await window.api.deleteTag(id)
      _allTags = _allTags.filter(x => x.id !== id)
      if (_tagId === id) { _folder = 'all'; _tagId = null; writeHash() }
      const root = document.getElementById('modal-content'); if (root) root.innerHTML = tagsModalContent()
      await loadAll(); render(); showToast(t('tickets.tags.toast.deleted'), 'success')
    } catch { showToast(t('error.generic'), 'error') }
  }
}
function tagsModalContent() {
  return `
    <div class="modal-title">${t('tickets.tags.manage')}</div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="tg-name" placeholder="${t('tickets.tags.name_placeholder')}" style="flex:1;min-width:160px" autocomplete="off">
        <select class="form-select" id="tg-color" style="width:auto">${TAG_COLOR_KEYS.map(k => `<option value="${k}">${TAG_PALETTE[k].label}</option>`).join('')}</select>
        <button class="btn btn-primary btn-sm" onclick="window.tkCreateTag()">${t('btn.create')}</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto">
        ${_allTags.length ? _allTags.map(g => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--bg-secondary)">
            ${tagChip(g)}
            <button class="btn btn-sm btn-ghost" onclick="window.tkDeleteTag('${g.id}', ${jsArg(g.name)})"><i class="ti ti-trash"></i></button>
          </div>`).join('') : `<div style="font-size:12px;color:var(--text-tertiary);padding:8px">${t('tickets.tags.empty')}</div>`}
      </div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.close')}</button></div>`
}

// ── Diagnostic du pont mail ─────────────────────────────────────────────────

// Bloc « configuration + curseurs » du diagnostic mail. Fonction pure,
// testée dans api/tests/lib/front-audit-view.test.js : les champs d'une boîte
// bloquée viennent d'un mail externe et d'une erreur DB → échappés.
function renderMailDiagConfig(diag, status) {
  if (!diag) return ''
  const c = diag.config || {}; const cls = c.classifier || {}
  const dot = (on) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${on ? 'var(--green)' : 'var(--red)'};vertical-align:1px;margin-right:6px"></span>`
  const blockedLine = (b) => b ? `<div style="color:var(--red);font-weight:600">${esc(t('tickets.mail_diag.blocked', { since: b.since ? formatRelative(b.since) : '?', attempts: b.attempts, id: b.internet_message_id || '?', error: b.error || '?' }))}</div>` : ''
  return `<section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px">${t('tickets.mail_diag.config')}</div>
      <div style="background:var(--bg-tertiary);border-radius:6px;padding:10px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
        <div>${dot(c.poll_enabled)} ${t('tickets.mail_diag.poll_enabled')}</div><div style="color:var(--text-secondary)">${esc(c.inboxes) || '(aucune)'}</div>
        <div>${dot(c.send_enabled)} ${t('tickets.mail_diag.send_enabled')}</div><div style="color:var(--text-secondary)">${esc(c.sender_address) || '(non configuré)'}</div>
        <div>${dot(c.mark_as_read_enabled)} ${t('tickets.mail_diag.mark_read_enabled')}</div><div style="color:var(--text-secondary)">${c.mark_as_read_enabled ? t('common.yes') : t('common.no')}</div>
        <div>${dot(cls.enabled && cls.url && cls.model)} ${t('tickets.mail_diag.classifier')}</div><div style="color:var(--text-secondary)">${cls.enabled ? `${esc(cls.model || '(?)')} @ ${esc(cls.url || '(?)')}` : t('tickets.mail_diag.classifier_off')}</div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary)">
        ${(status?.mailboxes || []).map(m => `<div>${esc(m.address)} — ${t('tickets.mail_diag.cursor')}: ${m.cursor ? formatRelative(m.cursor) : '(init)'} · ${m.total_ingested} ${t('tickets.mail_diag.ingested')}</div>${blockedLine(m.blocked)}`).join('')}
        ${(status?.sent_mailboxes || []).map(m => `<div>${esc(m.address)} — ${t('tickets.mail_diag.sent')} · ${t('tickets.mail_diag.cursor')}: ${m.cursor ? formatRelative(m.cursor) : '(init)'}</div>${blockedLine(m.blocked)}`).join('')}
      </div>
    </section>`
}

async function openMailDiagnosticModal() {
  showModal(`
    <div class="modal-title">${t('tickets.mail_diag.title')}</div>
    <div id="mail-diag-body" style="max-height:72vh;overflow-y:auto;margin-top:10px;font-size:13px">
      <div style="text-align:center;color:var(--text-tertiary);padding:20px">${t('common.loading')}…</div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.close')}</button></div>`)
  document.getElementById('modal-content')?.classList.add('modal-wide')
  const [stats, recent, diag, status] = await Promise.all([
    window.api.getEmailStats(7).catch(() => null),
    window.api.getEmailRecent({ limit: 50 }).catch(() => []),
    window.api.getEmailDiagnostic().catch(() => null),
    window.api.getEmailStatus().catch(() => null),
  ])
  const body = document.getElementById('mail-diag-body')
  if (!body) return
  const a = stats?.by_action || {}
  const actionLabel = { pending_review: t('tickets.inbox.short'), proposal_created: t('tickets.mail_diag.label_proposal'), proposal_created_no_match: t('tickets.mail_diag.label_proposal_reply'), message_appended: t('tickets.mail_diag.label_appended'), skipped_other: t('tickets.mail_diag.label_other'), skipped_error: t('tickets.mail_diag.label_error') }
  body.innerHTML = `
    ${renderMailDiagConfig(diag, status)}
    ${stats ? `<section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px">${t('tickets.mail_diag.activity', { n: stats.total, days: stats.days })}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${Object.entries(a).filter(([, n]) => n).map(([k, n]) => `<span class="badge badge-gray">${n} · ${esc(actionLabel[k] || k)}</span>`).join('')}</div>
    </section>` : ''}
    <section style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:6px">${t('tickets.mail_diag.recent_title')} (${recent.length})</div>
      ${recent.length ? `<div style="background:var(--bg-tertiary);border-radius:6px;overflow:hidden">${recent.map(r => `
        <div style="padding:8px 10px;border-bottom:0.5px solid var(--border);display:flex;gap:8px;align-items:center">
          <div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject || '(sans sujet)')}</div><div style="font-size:11px;color:var(--text-tertiary)">${esc(r.from_address || '?')} · ${formatRelative(r.received_at)}</div></div>
          <span class="badge badge-gray">${esc(actionLabel[r.action] || r.action || '?')}</span>
        </div>`).join('')}</div>` : `<div style="color:var(--text-tertiary);font-size:12px">${t('tickets.mail_diag.recent_empty')}</div>`}
    </section>
    ${(diag?.recent_errors || []).length ? `<section><div style="font-weight:600;margin-bottom:6px;color:var(--red)">${t('tickets.mail_diag.errors_title')}</div>
      ${diag.recent_errors.map(e => `<div style="padding:4px 0;border-bottom:0.5px solid var(--border);font-size:12px"><div>${esc(e.subject || '(sans sujet)')}</div><div style="color:var(--text-tertiary)">${esc(e.error_message || e.classifier_result?.reason || '')}</div></div>`).join('')}</section>` : ''}`
}
