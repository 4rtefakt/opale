// Tickets (mobile) — même lecture que le desktop : des dossiers (À trier, À
// répondre, Les miens, Non assignés, Tous, Résolus, Archives), une ligne par
// ticket avec la couleur de ce qu'il attend, une action évidente à droite.
// Toucher une ligne ouvre la page focus et mémorise la file pour « Terminé &
// suivant ». Les mails à trier sont regroupés par fil ; la feuille montre le
// fil complet puis : créer un ticket / rattacher / ignorer.

import { cleanSubject, shortName, nextLabel, prioLabel, buildQueue, saveQueue, TAG_PALETTE } from '/views/ticket-shared.js'

// Couleur de fond par nom de couleur de tag (TAG_PALETTE porte { bg, fg }).
const TAG_BG = Object.fromEntries(Object.entries(TAG_PALETTE).map(([k, v]) => [k, v.bg]))

const FOLDERS = ['inbox', 'needs', 'mine', 'unassigned', 'all', 'resolved', 'closed', 'proposed']
let _folder  = 'needs'
let _tickets = []
let _closed  = []
let _inbox   = []
let _inboxThreads = []
let _proposals = []
let _proposalsCount = 0
let _allTags = []
let _adv     = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
let _q       = ''
let _searchTimer = null
let _rows    = []

// jsArg() fourni globalement par mobile-app.js (window.jsArg)
const mJsArg = window.jsArg

function readHash() {
  const sp = new URLSearchParams((window.location.hash.split('?')[1] || ''))
  const f = sp.get('folder')
  if (FOLDERS.includes(f)) _folder = f
}
function writeHash() {
  const h = _folder === 'needs' ? '#/tickets' : `#/tickets?folder=${_folder}`
  if (window.location.hash !== h) history.replaceState(null, '', h)
}

function displayWhen(tk) {
  if (!tk.updated_at || tk.updated_at === tk.created_at) return formatRelative(tk.created_at)
  return `MAJ ${formatRelative(tk.updated_at)}`
}

export async function renderTickets(el) {
  _adv = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
  _q   = ''
  readHash()
  el.innerHTML = `
    <div class="m-header big">
      <div class="m-head-text">
        <h1>${esc(t('tickets.title'))}<span class="m-count" id="m-tk-count"></span></h1>
      </div>
      <div class="m-actions">
        <button class="m-icon-btn" onclick="mTkOpenFilters()" id="m-tk-filters-btn" title="${esc(t('tickets.filters.advanced'))}"><i class="ti ti-adjustments-horizontal"></i></button>
        <button class="m-icon-btn primary" onclick="mNewTicket()" title="${esc(t('tickets.new.title'))}"><i class="ti ti-plus"></i></button>
      </div>
    </div>
    <div class="m-search">
      <i class="ti ti-search"></i>
      <input type="text" placeholder="${esc(t('mobile.tickets.search_ph'))}" id="m-tk-q" oninput="mTkFilter()">
    </div>
    <div class="m-filters" id="m-tk-folders"></div>
    <div id="m-tk-active-chips" style="padding:4px 16px 0;display:none;flex-wrap:wrap;gap:4px"></div>
    <div class="m-scroll-list" id="m-tk-list">
      <div class="m-loading-row"><div class="m-spinner"></div></div>
    </div>`

  // Recherche : filtre local immédiat (titre / poste / demandeur) puis appel
  // backend débounce avec ?q= (description, messages, personnes).
  window.mTkFilter = () => {
    _q = document.getElementById('m-tk-q')?.value || ''
    render()
    if (_searchTimer) clearTimeout(_searchTimer)
    _searchTimer = setTimeout(async () => { _searchTimer = null; await refresh() }, 300)
  }
  window.mTkSetFolder = async (f) => {
    const wasClosed = _folder === 'closed'
    _folder = f
    writeHash()
    renderFolders()
    if ((f === 'closed' && !wasClosed) || f === 'proposed') { await refresh(); return }
    render()
  }
  window.mTkQueue = (id) => saveQueue(buildQueue(_rows), _folder)
  Object.assign(window, {
    mTkOpenFilters, mTkApplyAdv, mTkClearAdv, mTkRemoveChip, mTkAcceptProposal, mTkRejectProposal,
    mInboxOpen, mInboxToTicket, mInboxDismiss, mInboxAttach, mNewTicket,
  })

  await loadTags()
  await refresh()
}

// Recharge tout puis repeint dossiers et liste. En cas d'échec, loadAll a déjà
// affiché l'erreur avec « Réessayer » : rien d'autre à peindre.
async function refresh() {
  if (await loadAll()) { renderFolders(); render() }
}

async function loadTags() { try { _allTags = await window.api.getTags() } catch { _allTags = [] } }

// Retourne true si le chargement a réussi (false : l'erreur est affichée).
async function loadAll() {
  const list = document.getElementById('m-tk-list')
  const params = { limit: 200 }
  if (_adv.priority.length) params.priority     = _adv.priority.join(',')
  if (_adv.tag.length)      params.tag          = _adv.tag.join(',')
  if (_adv.assigned_to)     params.assigned_to  = _adv.assigned_to
  if (_adv.created_from)    params.created_from = _adv.created_from
  if (_adv.created_to)      params.created_to   = _adv.created_to
  if (_q.trim())            params.q            = _q.trim()
  try {
    const [tickets, inbox, closed, proposals, pc] = await Promise.all([
      window.api.getTickets(params),
      window.api.getInbox({ limit: 200 }).catch(() => []),
      _folder === 'closed' ? window.api.getTickets({ ...params, status: 'closed' }).catch(() => []) : Promise.resolve([]),
      _folder === 'proposed' ? window.api.getProposals({ status: 'pending' }).catch(() => []) : Promise.resolve([]),
      window.api.getProposalsCount().catch(() => ({ pending: 0 })),
    ])
    _tickets = tickets
    _inbox = inbox
    _inboxThreads = groupInboxThreads(inbox)
    _closed = closed
    _proposals = proposals
    _proposalsCount = pc.pending || 0
    renderActiveChips()
    // Après un tri (→ ticket, ignorer, rattacher) : le badge suit tout de suite.
    window.mUpdateTicketsBadge?.()
    return true
  } catch (err) {
    if (list) list.innerHTML = mErrorBox(err.message, refresh)
    return false
  }
}

// ── Dossiers ────────────────────────────────────────────────────────────────

function counts() {
  const me = window.appState?.user?.entraId
  const live = _tickets.filter(tk => ['open', 'in_progress'].includes(tk.status))
  return {
    inbox: _inboxThreads.length,
    needs: live.filter(tk => tk.awaiting_reply).length,
    mine: live.filter(tk => tk.assigned_to_entra_id === me).length,
    unassigned: live.filter(tk => !tk.assigned_to_entra_id).length,
    all: live.length,
    resolved: _tickets.filter(tk => tk.status === 'resolved').length,
  }
}

function renderFolders() {
  const el = document.getElementById('m-tk-folders')
  if (!el) return
  const c = counts()
  const f = (key, icon, label, n, cls = '') => `
    <button class="m-filter-pill ${_folder === key ? 'active' : ''}" onclick="mTkSetFolder('${key}')">
      <i class="ti ${icon}"></i>${esc(label)}${n != null ? `<span class="cnt ${cls}">${n}</span>` : ''}
    </button>`
  el.innerHTML =
    f('inbox', 'ti-mail-opened', t('tickets.folder.inbox'), c.inbox, c.inbox ? 'hot' : '') +
    f('needs', 'ti-corner-down-right', t('tickets.folder.needs'), c.needs, c.needs ? 'needs' : '') +
    f('mine', 'ti-user', t('tickets.folder.mine'), c.mine) +
    f('unassigned', 'ti-user-off', t('tickets.folder.unassigned'), c.unassigned) +
    f('all', 'ti-list', t('tickets.folder.all'), c.all) +
    f('resolved', 'ti-check', t('tickets.folder.resolved'), c.resolved) +
    f('closed', 'ti-archive', t('tickets.folder.closed'), null) +
    (_proposalsCount || _folder === 'proposed' ? f('proposed', 'ti-bulb', t('tickets.proposals.title'), _proposalsCount) : '')
  // Le dossier actif reste visible dans la rangée défilante.
  el.querySelector('.m-filter-pill.active')?.scrollIntoView({ inline: 'center', block: 'nearest' })
}

// ── Liste ───────────────────────────────────────────────────────────────────

function visibleTickets() {
  const me = window.appState?.user?.entraId
  const live = _tickets.filter(tk => ['open', 'in_progress'].includes(tk.status))
  let list
  switch (_folder) {
    case 'needs':      list = live.filter(tk => tk.awaiting_reply); break
    case 'mine':       list = live.filter(tk => tk.assigned_to_entra_id === me); break
    case 'unassigned': list = live.filter(tk => !tk.assigned_to_entra_id); break
    case 'resolved':   list = _tickets.filter(tk => tk.status === 'resolved'); break
    case 'closed':     list = _closed; break
    default:           list = live
  }
  const q = _q.trim().toLowerCase()
  if (q) {
    // Le backend (via ?q=) matche aussi description / messages / personnes :
    // si le filtre local ne trouve rien alors que la liste n'est pas vide, on
    // la garde plutôt que de masquer un résultat valide.
    const m = list.filter(tk => (tk.title || '').toLowerCase().includes(q) || (tk.hostname || '').toLowerCase().includes(q)
      || (tk.requester_name || '').toLowerCase().includes(q))
    if (m.length || !list.length) list = m
  }
  return list
}

// Groupes : « à répondre » (qui attend depuis le plus longtemps d'abord),
// puis critiques, puis le reste par activité récente.
function groupTickets(list) {
  const waited = tk => Date.parse(tk.updated_at || tk.created_at)
  const live = tk => ['open', 'in_progress'].includes(tk.status)
  const needs = list.filter(tk => tk.awaiting_reply && live(tk)).sort((a, b) => waited(a) - waited(b))
  const crit  = list.filter(tk => !needs.includes(tk) && tk.priority === 'critical' && live(tk))
  const rest  = list.filter(tk => !needs.includes(tk) && !crit.includes(tk)).sort((a, b) => waited(b) - waited(a))
  const groups = []
  if (needs.length) groups.push({ key: 'needs', label: t('tickets.folder.needs'), list: needs })
  if (crit.length)  groups.push({ key: 'crit',  label: t('tickets.group.critical'), list: crit })
  if (rest.length)  groups.push({ key: 'rest',  label: _folder === 'resolved' ? t('tickets.group.resolved') : _folder === 'closed' ? t('tickets.group.closed') : t('tickets.group.rest'), list: rest })
  return groups
}

function render() {
  const list = document.getElementById('m-tk-list')
  if (!list) return
  if (_folder === 'inbox')    return renderInboxList()
  if (_folder === 'proposed') return renderProposals()
  const rows = visibleTickets()
  const groups = groupTickets(rows)
  _rows = groups.flatMap(g => g.list)
  const cnt = document.getElementById('m-tk-count')
  if (cnt) cnt.textContent = rows.length ? `· ${rows.length}` : ''
  if (!rows.length) {
    list.innerHTML = `<div class="m-empty"><i class="ti ${_folder === 'needs' ? 'ti-mood-smile' : 'ti-inbox'}"></i><span>${esc(_q.trim() ? t('tickets.inbox.no_match') : t('tickets.folder_empty.' + _folder))}</span></div>`
    return
  }
  list.innerHTML = groups.map(g => `
    <div class="m-group ${g.key}"><span class="dot"></span>${esc(g.label)} <span class="n">${g.list.length}</span></div>
    ${g.list.map(tk => rowHtml(tk)).join('')}`).join('')
}

function rowHtml(tk) {
  const me = window.appState?.user?.entraId
  const nx = nextLabel(tk)
  const kind = nx.cls === 'needs' ? 'needs' : nx.cls === 'crit' ? 'crit' : nx.cls === 'done' ? 'done' : 'quiet'
  const who = shortName(tk.requester_name) || tk.hostname || ''
  const assignee = !tk.assigned_to_entra_id ? t('tickets.unassigned') : tk.assigned_to_entra_id === me ? t('today.why.you') : shortName(tk.assigned_to_name)
  const why = [
    who ? `<i class="ti ti-user"></i> ${esc(who)}` : '',
    tk.hostname && who !== tk.hostname ? `<i class="ti ti-device-laptop"></i> ${esc(tk.hostname)}` : '',
    tk.priority === 'high' ? `<span style="color:var(--amber)">${esc(prioLabel(tk.priority))}</span>` : '',
    esc(displayWhen(tk)),
  ].filter(Boolean).join(' · ')
  const tags = (tk.tags || []).slice(0, 3).map(g => `<span class="m-ticket-tag" style="background:${TAG_BG[g.color] || TAG_BG.slate}">${esc(g.name)}</span>`).join('')
  return `
    <a class="m-tk-row ${kind}" href="#/ticket/${esc(tk.id)}" onclick="mTkQueue()">
      <span class="bar"></span>
      <span style="min-width:0">
        <div class="ttl">${esc(tk.title)}</div>
        <div class="why">${why}</div>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
      </span>
      <span class="act">${esc(nx.label)}<small>${esc(assignee)}</small></span>
    </a>`
}

// ── Propositions (tickets suggérés par une alerte, un script, l'IA) ────────

function renderProposals() {
  const list = document.getElementById('m-tk-list')
  const cnt = document.getElementById('m-tk-count')
  if (cnt) cnt.textContent = _proposals.length ? `· ${_proposals.length}` : ''
  if (!_proposals.length) { list.innerHTML = `<div class="m-empty"><i class="ti ti-bulb-off"></i><span>${esc(t('tickets.proposals.empty'))}</span></div>`; return }
  list.innerHTML = _proposals.map(p => {
    const src = t('tickets.proposals.source.' + p.source)
    const prioColor = p.suggested_priority === 'critical' ? 'var(--red)' : p.suggested_priority === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
    return `
    <div class="m-ticket-card">
      <div class="m-ticket-title" style="white-space:normal">${esc(p.suggested_title)}</div>
      <div class="m-ticket-meta"><span class="m-pill m-pill-off">${esc(src.startsWith('tickets.') ? p.source : src)}</span><span class="m-ticket-sep">·</span><span class="m-ticket-prio-dot" style="background:${prioColor}"></span>${esc(prioLabel(p.suggested_priority))}<span class="m-ticket-sep">·</span>${formatRelative(p.created_at)}</div>
      ${p.suggested_description ? `<div style="font-size:12.5px;color:var(--text-secondary);white-space:pre-wrap;max-height:90px;overflow:auto">${esc(p.suggested_description)}</div>` : ''}
      <div class="m-actionrow" style="padding:4px 0 0">
        <button class="m-btn sm" onclick="mTkRejectProposal('${esc(p.id)}',this)">${esc(t('tickets.proposals.reject'))}</button>
        <button class="m-btn sm primary" onclick="mTkAcceptProposal('${esc(p.id)}',this)"><i class="ti ti-check"></i> ${esc(t('tickets.proposals.accept'))}</button>
      </div>
    </div>`
  }).join('')
}

async function mTkAcceptProposal(id, btn) {
  await withBusy(btn, async () => {
    try {
      const out = await window.api.acceptProposal(id, {})
      window.showToast(t('tickets.proposals.toast.accepted'), 'success')
      if (out?.ticket?.id || out?.id) window.location.hash = `#/ticket/${out.ticket?.id || out.id}`
      else await refresh()
    } catch (err) { window.showToast(err?.body?.error || err.message || t('mobile.ticket.toast.error'), 'error') }
  })
}

async function mTkRejectProposal(id, btn) {
  const reason = prompt(t('tickets.proposals.reject_reason_prompt'))
  if (reason === null) return
  await withBusy(btn, async () => {
    try {
      await window.api.rejectProposal(id, reason || null)
      window.showToast(t('tickets.proposals.toast.rejected'), 'info')
      await refresh()
    } catch (err) { window.showToast(err?.body?.error || err.message || t('mobile.ticket.toast.error'), 'error') }
  })
}


// ── Mails à trier ───────────────────────────────────────────────────────────
// Un fil (= conversation Outlook) par ligne, le plus ancien d'abord ; la
// feuille montre les mails du fil avec leur corps complet, puis : créer un
// ticket / rattacher / ignorer.

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
    th.first  = th.mails[0]
    th.count  = Math.max(th.mails.length, th.latest.thread_count || 1)
    return th
  }).sort((a, b) => Date.parse(a.first.received_at || 0) - Date.parse(b.first.received_at || 0))
}

const cleanSubjectM = (s) => cleanSubject(s, t('tickets.inbox.no_subject'))

function renderInboxList() {
  const list = document.getElementById('m-tk-list')
  if (!list) return
  const q = _q.trim().toLowerCase()
  const threads = _inboxThreads.filter(th => !q
    || (th.latest.subject || '').toLowerCase().includes(q)
    || th.mails.some(m => (m.from_name || m.from_address || '').toLowerCase().includes(q)))
  const cnt = document.getElementById('m-tk-count')
  if (cnt) cnt.textContent = threads.length ? `· ${threads.length}` : ''
  if (!threads.length) {
    list.innerHTML = `<div class="m-empty"><i class="ti ti-mail-check"></i><b>${esc(q ? t('tickets.inbox.no_match') : t('tickets.inbox.all_done'))}</b>${q ? '' : `<span>${esc(t('tickets.inbox.empty_hint'))}</span>`}</div>`
    return
  }
  list.innerHTML = `<div class="m-group"><span class="dot" style="background:var(--needs)"></span>${esc(t('tickets.inbox.list_hint'))}</div>` + threads.map(th => {
    const m = th.latest
    const who = m.suggested_user_name || m.from_name || m.from_address || '?'
    return `
      <div class="m-tk-row needs" role="button" onclick="mInboxOpen(${mJsArg(th.key)})">
        <span class="bar"></span>
        <span style="min-width:0">
          <div class="ttl">${esc(cleanSubjectM(m.subject))}</div>
          <div class="why"><i class="ti ti-user"></i> ${esc(who)}${th.count > 1 ? ` · ${esc(t('tickets.inbox.thread_n', { n: th.count }))}` : ''}${m.suggested_device_hostname ? ` · <i class="ti ti-device-laptop"></i> ${esc(m.suggested_device_hostname)}` : ''} · ${esc(formatRelative(m.received_at))}</div>
          ${m.body_preview ? `<div class="why" style="color:var(--text-tertiary)">${esc(m.body_preview)}</div>` : ''}
        </span>
        <span class="act">${esc(t('tickets.inbox.short'))} →</span>
      </div>`
  }).join('')
}

async function mInboxOpen(key) {
  const th = _inboxThreads.find(x => x.key === key)
  if (!th) return
  const m = th.latest
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(cleanSubjectM(m.subject))}</div>
    <div style="padding:10px 0 8px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5">
        ${m.suggested_user_name ? `<i class="ti ti-user"></i> <b>${esc(m.suggested_user_name)}</b> · ${esc(t('tickets.inbox.will_be_requester'))}` : `<i class="ti ti-user-question"></i> ${esc(m.from_address || '')} · ${esc(t('tickets.inbox.external'))}`}
        ${th.count > 1 ? `<br><i class="ti ti-messages"></i> ${esc(t('tickets.inbox.thread_hint', { n: th.count }))}` : ''}
      </div>
      <div id="m-inbox-thread" style="display:flex;flex-direction:column;gap:8px;max-height:45vh;overflow-y:auto">
        <div class="m-loading-row"><div class="m-spinner sm"></div></div>
      </div>
      <button class="m-btn primary block" onclick="mInboxToTicket(${mJsArg(m.id)}, this)"><i class="ti ti-ticket"></i> ${esc(th.count > 1 ? t('tickets.inbox.to_ticket_n', { n: th.count }) : t('mobile.tickets.inbox.to_ticket'))}</button>
      <div style="display:flex;gap:8px">
        <button class="m-btn" style="flex:1" onclick="mInboxAttach(${mJsArg(m.id)})"><i class="ti ti-arrows-join"></i> ${esc(t('mobile.tickets.inbox.attach'))}</button>
        <button class="m-btn ghost" style="flex:1" onclick="mInboxDismiss(${mJsArg(m.id)}, ${th.count > 1 ? 'true' : 'false'}, this)"><i class="ti ti-eye-off"></i> ${esc(t('tickets.inbox.dismiss'))}</button>
      </div>
    </div>`)

  let items
  try { items = await window.api.getInboxThread(m.id) } catch { items = th.mails }
  const host = document.getElementById('m-inbox-thread')
  if (!host) return
  host.innerHTML = items.map(it => `
    <div class="m-msg-bubble ${it.direction === 'outbound' ? 'm-msg-bubble-me' : ''}" style="max-width:none;border-radius:12px">
      <div class="m-msg-author" style="display:flex;justify-content:space-between;gap:8px"><span>${esc(it.from_name || it.from_address || '?')}</span><span style="font-weight:400;color:var(--text-tertiary)">${esc(formatRelative(it.received_at))}</span></div>
      <div class="m-msg-content" id="m-inbox-body-${esc(it.id)}" style="color:var(--text-secondary)">${esc(it.body_preview || '')}</div>
    </div>`).join('')
  await Promise.all(items.map(async it => {
    try {
      const b = await window.api.getInboxBody(it.id)
      const el = document.getElementById(`m-inbox-body-${it.id}`)
      if (el && b.body_text) { el.textContent = b.body_text; el.style.color = '' }
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
      else await refresh()
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  })
}

async function mInboxDismiss(mappingId, wholeThread, btn) {
  if (!confirm(wholeThread ? t('tickets.inbox.confirm_dismiss_thread') : t('tickets.inbox.confirm_dismiss'))) return
  await withBusy(btn, async () => {
    try {
      await window.api.inboxDismiss(mappingId, wholeThread)
      window.mCloseSheet()
      await refresh()
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  })
}

function mInboxAttach(mappingId) {
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t('tickets.inbox.attach_title'))}</div>
    <div style="padding:10px 0 8px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12.5px;color:var(--text-secondary)">${esc(t('tickets.inbox.attach_help'))}</div>
      <input class="m-input" id="m-inbox-attach-q" placeholder="${esc(t('tickets.merge.search'))}" autocomplete="off">
      <div id="m-inbox-attach-results" class="m-picklist" style="max-height:45vh"></div>
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
      <div onclick="window.mInboxConfirmAttach(${mJsArg(mappingId)}, '${esc(tk.id)}', ${mJsArg(tk.title)})">
        <div style="font-weight:500">${esc(tk.title)}</div>
        <div class="sub">${tk.requester_name ? esc(shortName(tk.requester_name)) + ' · ' : ''}${esc(displayWhen(tk))}</div>
      </div>`).join('') : `<div class="sub">${esc(t('tickets.merge.no_match'))}</div>`
  }
  let timer
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250) })
  search()
  window.mInboxConfirmAttach = async (mid, ticketId, title) => {
    if (!confirm(t('tickets.inbox.attach_confirm', { title }))) return
    try {
      const out = await window.api.inboxAttach(mid, ticketId)
      window.mCloseSheet()
      window.showToast(t('tickets.inbox.attached', { n: out.appended }), 'success')
      window.location.hash = `#/ticket/${ticketId}`
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  }
}

// ── Filtres avancés ─────────────────────────────────────────────────────────

function renderActiveChips() {
  const el = document.getElementById('m-tk-active-chips')
  if (!el) return
  const chips = []
  for (const p of _adv.priority) chips.push(advChip(`${t('tickets.filters.priority')} : ${prioLabel(p)}`, `priority:${p}`))
  for (const id of _adv.tag) {
    const g = _allTags.find(x => x.id === id)
    chips.push(advChip(`${t('tickets.filters.tags')} : ${g?.name || id}`, `tag:${id}`))
  }
  if (_adv.assigned_to) {
    const lbl = _adv.assigned_to === 'me' ? t('tickets.filters.assignee_me') : _adv.assigned_to === 'unassigned' ? t('tickets.filters.assignee_unassigned') : _adv.assigned_to
    chips.push(advChip(`${t('tickets.filters.assignee')} : ${lbl}`, 'assigned_to'))
  }
  if (_adv.created_from) chips.push(advChip(`${t('tickets.filters.from')} ${_adv.created_from}`, 'created_from'))
  if (_adv.created_to)   chips.push(advChip(`${t('tickets.filters.to')} ${_adv.created_to}`, 'created_to'))
  el.style.display = chips.length ? 'flex' : 'none'
  el.innerHTML = chips.join('')
}

function advChip(label, key) {
  return `<span class="m-chip">${esc(label)} <span class="x" onclick="mTkRemoveChip(${mJsArg(key)})">×</span></span>`
}

async function mTkRemoveChip(key) {
  if (key.startsWith('priority:')) _adv.priority = _adv.priority.filter(x => x !== key.split(':')[1])
  else if (key.startsWith('tag:')) _adv.tag = _adv.tag.filter(x => x !== key.split(':')[1])
  else if (key === 'assigned_to') _adv.assigned_to = ''
  else if (key === 'created_from') _adv.created_from = ''
  else if (key === 'created_to') _adv.created_to = ''
  await refresh()
}

function mTkOpenFilters() {
  const prios = ['low', 'normal', 'high', 'critical']
  window.mShowSheet(`
    <div class="m-sheet-title"><i class="ti ti-adjustments-horizontal"></i> ${esc(t('tickets.filters.advanced'))}</div>
    <div style="display:flex;flex-direction:column;gap:14px;padding:12px 0 4px">
      <div>
        <div class="m-label">${esc(t('tickets.filters.priority'))}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${prios.map(p => `<button class="m-filter-pill ${_adv.priority.includes(p) ? 'active' : ''}" data-pf="${p}">${esc(prioLabel(p))}</button>`).join('')}
        </div>
      </div>
      <div>
        <div class="m-label">${esc(t('tickets.filters.tags'))}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${_allTags.length ? _allTags.map(g => `
            <button class="m-filter-pill ${_adv.tag.includes(g.id) ? 'active' : ''}" data-tg="${esc(g.id)}"
              style="${_adv.tag.includes(g.id) ? `background:${TAG_BG[g.color] || TAG_BG.slate};color:#fff` : ''}">${esc(g.name)}</button>`).join('')
            : `<span class="m-muted" style="font-size:12px">${esc(t('mobile.ticket.tags.empty'))}</span>`}
        </div>
      </div>
      <div>
        <div class="m-label">${esc(t('tickets.filters.assignee'))}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          <button class="m-filter-pill ${_adv.assigned_to === 'me' ? 'active' : ''}" data-as="me">${esc(t('tickets.filters.assignee_me'))}</button>
          <button class="m-filter-pill ${_adv.assigned_to === 'unassigned' ? 'active' : ''}" data-as="unassigned">${esc(t('tickets.filters.assignee_unassigned'))}</button>
          <button class="m-filter-pill ${_adv.assigned_to === '' ? 'active' : ''}" data-as="">${esc(t('tickets.filter.all'))}</button>
        </div>
      </div>
      <div>
        <div class="m-label">${esc(t('mobile.tickets.filters.dates'))}</div>
        <div style="display:flex;gap:8px">
          <input type="date" class="m-input" id="m-tk-from" value="${esc(_adv.created_from)}" style="flex:1">
          <input type="date" class="m-input" id="m-tk-to"   value="${esc(_adv.created_to)}"   style="flex:1">
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="m-btn" style="flex:1" onclick="mTkClearAdv()">${esc(t('tickets.filters.clear'))}</button>
        <button class="m-btn primary" style="flex:1" onclick="mTkApplyAdv()">${esc(t('btn.apply'))}</button>
      </div>
    </div>`)

  setTimeout(() => {
    document.querySelectorAll('[data-pf]').forEach(btn => btn.addEventListener('click', () => {
      const p = btn.dataset.pf
      const i = _adv.priority.indexOf(p)
      if (i === -1) _adv.priority.push(p); else _adv.priority.splice(i, 1)
      btn.classList.toggle('active')
    }))
    document.querySelectorAll('[data-tg]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.tg
      const i = _adv.tag.indexOf(id)
      if (i === -1) _adv.tag.push(id); else _adv.tag.splice(i, 1)
      const on = btn.classList.toggle('active')
      const g = _allTags.find(x => x.id === id)
      btn.style.background = on ? (TAG_BG[g?.color] || TAG_BG.slate) : ''
      btn.style.color = on ? '#fff' : ''
    }))
    document.querySelectorAll('[data-as]').forEach(btn => btn.addEventListener('click', () => {
      _adv.assigned_to = btn.dataset.as
      document.querySelectorAll('[data-as]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    }))
  }, 50)
}

async function mTkApplyAdv() {
  // Lire les dates AVANT de fermer la feuille (mCloseSheet vide le DOM interne).
  _adv.created_from = document.getElementById('m-tk-from')?.value || ''
  _adv.created_to   = document.getElementById('m-tk-to')?.value   || ''
  window.mCloseSheet()
  await refresh()
}

async function mTkClearAdv() {
  _adv = { priority: [], tag: [], assigned_to: '', created_from: '', created_to: '' }
  window.mCloseSheet()
  await refresh()
}

// ── Nouveau ticket ──────────────────────────────────────────────────────────

// Feuille « Nouveau ticket » : titre + priorité, puis les champs rares
// (demandeur, poste, tags, description). `prefill.device` = { id, hostname }.
export function mNewTicket(prefill = {}) {
  const me = window.appState?.user
  let pickedAssignee  = null  // { entra_id, display_name }
  let pickedRequester = null  // { entra_id, display_name, email }
  let pickedDevice    = prefill.device || null  // { id, hostname }
  let selectedTags    = []    // [{ id, name, color }, ...]
  let _devCache       = null  // liste devices chargée à la demande

  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.tickets.new.title')}</div>
    <div class="m-form">
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
          <div id="m-nti-rr" class="m-picklist"></div>
        </div>
      </div>

      <!-- Poste concerné : search + picker -->
      <div>
        <div class="m-label">${t('mobile.tickets.new.field.device')}</div>
        <div id="m-nti-device" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"></div>
        <div id="m-nti-device-search" style="display:none;margin-top:6px">
          <input class="m-input" id="m-nti-dq" placeholder="${t('mobile.tickets.new.device_search')}" autocomplete="off">
          <div id="m-nti-dr" class="m-picklist"></div>
        </div>
      </div>

      <!-- Tags : picker compact -->
      <div>
        <div class="m-label">${t('mobile.tickets.new.field.tags')}</div>
        <div id="m-nti-tags" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center"></div>
        <div id="m-nti-tags-search" style="display:none;margin-top:6px">
          <input class="m-input" id="m-nti-tq" placeholder="${t('mobile.tickets.new.tags_search')}" autocomplete="off">
          <div id="m-nti-tl" class="m-picklist"></div>
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
      const color = TAG_BG[g.color] || TAG_BG.slate
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
      const color = TAG_BG[g.color] || TAG_BG.slate
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
        window.showToast(t('mobile.tickets.new.toast_created'), 'success')
        if (tk?.id) window.location.hash = `#/ticket/${tk.id}`
        else await refresh()
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
